//! Authenticated/admin/service legacy routes: `/donate`, `/offers/{id}/{ownership,reviews*}`, `/accounts`, `/users*`, `/push`, `/launcher`, `/admin`.
use super::common::node_bson as account_bson;
use super::{
    Routes,
    auth::{epic as authenticate_epic, verify_provider_jwt},
    catalog::query,
    common::{Error, ONE_MINUTE, Result, cache_header, many, ok, one},
};
use crate::{middleware::jwt::verify_jwt, state::AppState};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::Response,
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
};
use bson::{Bson, Document, doc};
use chrono::{DateTime, Utc};
use egdata_core::{
    error::CoreError,
    ports::{MongoFindOptions, UpstreamHttpRequest},
    sitemap::decrypt,
};
use egdata_infra::{
    auth_pg::parse_cookies,
    bson_json::{bson_doc_to_js_json, bson_to_js_json},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};

const LAUNCHER_CLIENT_ID: &str = "xyza7891xZ38uWZ6zLt8enN8oNxlLvWf";
const LAUNCHER_BASE_URL: &str =
    "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared";
const EPIC_TOKEN_INFO_URL: &str = "https://api.epicgames.dev/epic/oauth/v2/tokenInfo";
const EPIC_GRAPHQL_URL: &str = "https://store.epicgames.com/graphql";
const EPIC_STORE_USER_AGENT: &str =
    "EpicGamesLauncher/18.8.0-44107768+++Portal+Release-Live Windows/10.0.26100.1.256.64bit";
const DISCORD_DONATOR_GUILD_ID: &str = "561598657879605269";
const DISCORD_DONATOR_ROLE_ID: &str = "1379892703793512599";

pub(super) fn routes() -> Routes {
    Routes::new("")
        .post("/donate/key/{code}", donate_key_post)
        .get("/donate/key/{code}", donate_key_get)
        .get("/offers/{id}/ownership", offer_ownership)
        .post("/offers/{id}/reviews", offer_reviews_post)
        .patch("/offers/{id}/reviews", offer_reviews_patch)
        .delete("/offers/{id}/reviews", offer_reviews_delete)
        .get(
            "/offers/{id}/reviews/permissions",
            offer_reviews_permissions,
        )
        .get("/accounts", accounts_get)
        .get("/users", users_root)
        .post("/users/find-or-create", users_find_or_create)
        .get("/users/discord", users_discord_get)
        .post("/users/discord", users_discord_post)
        .put("/users/epic", users_epic_put)
        .delete("/users/epic", users_epic_delete)
        .get("/users/check-epic", users_check_epic)
        .get("/users-service", users_service_root)
        .post("/users-service/playtime", users_service_playtime)
        .post("/users-service/ownership", users_service_ownership)
        .post("/push/subscribe", push_subscribe_post)
        .get("/push/subscribe", push_subscribe_get)
        .delete(
            "/push/unsubscribe/{subscriptionId}",
            push_unsubscribe_delete,
        )
        .post("/push/topics/subscribe", push_topics_subscribe)
        .post("/push/topics/unsubscribe", push_topics_unsubscribe)
        .get("/push/subscriptions", push_subscriptions_list)
        .get(
            "/push/subscriptions/{subscriptionId}",
            push_subscriptions_get,
        )
        .post("/push/send", push_send)
        .post("/push/send-to-user", push_send_to_user)
        .get("/push/vapid-public-key", push_vapid_public_key)
        .get("/push/topics/stats", push_topics_stats)
        .get("/launcher/sandbox/{id}", launcher_sandbox)
        .get("/launcher/sandbox/{id}/items", launcher_sandbox_items)
        .get("/launcher/sandbox/{id}/offers", launcher_sandbox_offers)
        .get("/admin", admin_root)
        .post("/admin/offers", admin_offers_post)
        .patch("/admin/offers", admin_offers_patch)
}

fn json_err(status: StatusCode, body: Value) -> Error {
    Error::Json(status, body)
}

fn header_str<'a>(headers: &'a HeaderMap, name: &'a str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
}

fn cookie_header(headers: &HeaderMap) -> &str {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn parse_json_body(body: &Bytes) -> Result<Value> {
    serde_json::from_slice(body).map_err(|_| Error::Internal)
}

fn account_document(fields: &Map<String, Value>) -> Document {
    fields
        .iter()
        .map(|(key, value)| (key.clone(), account_bson(value)))
        .collect()
}

fn is_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn linked_account(auth: &super::auth::EpicAuthContext) -> Result<String> {
    auth.account_id().map(str::to_owned).ok_or_else(|| {
        json_err(
            StatusCode::UNAUTHORIZED,
            json!({"error":"Missing account ID"}),
        )
    })
}

fn bson_to_string_id(val: &Bson) -> String {
    match val {
        Bson::String(s) => s.clone(),
        Bson::ObjectId(oid) => oid.to_hex(),
        other => bson_to_js_json(other)
            .as_str()
            .map(str::to_string)
            .unwrap_or_default(),
    }
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let header_b64 = parts.next().unwrap();
    let payload_b64 = parts.next()?;
    let _sig = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let header_bytes = URL_SAFE_NO_PAD.decode(header_b64).ok()?;
    serde_json::from_slice::<Value>(&header_bytes)
        .ok()?
        .as_object()?;
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    serde_json::from_slice::<Value>(&payload_bytes).ok()
}

fn offer_released(offer: &Document, now: DateTime<Utc>) -> bool {
    let date = offer
        .get("releaseDate")
        .filter(|v| is_js_truthy(&bson_to_js_json(v)))
        .or_else(|| offer.get("effectiveDate"));
    // Relational comparison with a JavaScript Date converts both operands
    // to numbers. Only a native BSON Date contributes its ISO timestamp.
    let millis = match date {
        Some(Bson::DateTime(date)) => date.timestamp_millis() as f64,
        other => crate::v1::system::js_number_or_zero(other.map(bson_to_js_json).as_ref()),
    };
    millis <= now.timestamp_millis() as f64
}

async fn post_token_info(s: &AppState, token: &str) -> std::result::Result<(u16, Value), ()> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", token)
        .finish()
        .into_bytes();
    let req = UpstreamHttpRequest {
        method: "POST".into(),
        url: EPIC_TOKEN_INFO_URL.into(),
        headers: BTreeMap::from([(
            "Content-Type".into(),
            "application/x-www-form-urlencoded".into(),
        )]),
        body: Some(body),
        multipart_file: None,
    };
    let resp = s.http.send(req).await.map_err(|_| ())?;
    let json_val = serde_json::from_slice::<Value>(&resp.body).map_err(|_| ())?;
    Ok((resp.status, json_val))
}

async fn get_product(s: &AppState, offer_id: &str) -> Result<Option<Document>> {
    let Some(offer) = s
        .mongo
        .find_one("offers", doc! { "id": { "$eq": offer_id } }, None)
        .await?
    else {
        return Ok(None);
    };
    let Ok(namespace) = offer.get_str("namespace") else {
        return Ok(None);
    };
    let Some(sandbox) = s
        .mongo
        .find_one("sandboxes", doc! { "_id": { "$eq": namespace } }, None)
        .await?
    else {
        return Ok(None);
    };
    let Some(parent) = sandbox.get("parent") else {
        return Ok(None);
    };
    Ok(s.mongo
        .find_one("products", doc! { "_id": { "$eq": parent.clone() } }, None)
        .await?)
}

async fn verify_game_ownership(s: &AppState, account_id: &str, product_id: &str) -> bool {
    let Ok(Some(_)) = s.epic.get_user(account_id).await else {
        return false;
    };

    const QUERY: &str = r#"
      query playerProfileAchievementsByProductId(
        $epicAccountId: String!
        $productId: String!
      ) {
        PlayerProfile {
          playerProfile(epicAccountId: $epicAccountId) {
            epicAccountId
            displayName
            relationship
            avatar {
              small
              medium
              large
            }
            productAchievements(productId: $productId) {
              __typename
              ... on PlayerProductAchievementsResponseSuccess {
                data {
                  epicAccountId
                  sandboxId
                  totalXP
                  totalUnlocked
                  achievementSets {
                    achievementSetId
                    isBase
                    totalUnlocked
                    totalXP
                  }
                  playerAwards {
                    awardType
                    unlockedDateTime
                    achievementSetId
                  }
                  playerAchievements {
                    playerAchievement {
                      achievementName
                      epicAccountId
                      progress
                      sandboxId
                      unlocked
                      unlockDate
                      XP
                      achievementSetId
                      isBase
                    }
                  }
                }
              }
            }
          }
        }
      }
    "#;

    let Ok(resp) = s
        .epic
        .graphql(
            QUERY,
            &json!({ "epicAccountId": account_id, "productId": product_id }),
        )
        .await
    else {
        return false;
    };

    let pa = resp
        .pointer("/data/PlayerProfile/playerProfile/productAchievements")
        .or_else(|| resp.pointer("/PlayerProfile/playerProfile/productAchievements"))
        .filter(|v| !v.is_null());

    let Some(pa) = pa else {
        return false;
    };

    if pa.get("__typename").and_then(Value::as_str) == Some("ServiceError") {
        return false;
    }

    pa.pointer("/data/playerAchievements")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
}

async fn launcher_access_token(s: &AppState) -> Result<String> {
    let id = s
        .config
        .admin_account_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or(Error::Internal)?;
    let doc = s
        .mongo
        .find_one("launcher", doc! {"account_id":id}, None)
        .await?;
    doc.as_ref()
        .and_then(|d| d.get_str("access_token").ok())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or(Error::Internal)
}

// ============================================================================
// 1. Donate routes (`src/index.ts` L1347-1455)
// ============================================================================

async fn donate_key_post(
    State(s): State<AppState>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let auth = authenticate_epic(&s, &headers).await?;
    let Some(_session) = auth.session.as_ref() else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Missing session" }),
        ));
    };

    if code.encode_utf16().count() != 20 {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid code" }),
        ));
    }

    let id = linked_account(&auth)?;

    let existing = s
        .mongo
        .find_one("key-codes", doc! { "code": { "$eq": &code } }, None)
        .await?;
    if existing.is_some() {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Code already used" }),
        ));
    }

    let access_token = launcher_access_token(&s).await?;
    let admin_account = s.config.admin_account_id.as_deref().unwrap_or("");
    let mut fulfillment = url::Url::parse(
        "https://fulfillment-public-service-prod.ol.epicgames.com/fulfillment/api/public/accounts/",
    )
    .expect("valid fulfillment endpoint");
    fulfillment
        .path_segments_mut()
        .expect("valid fulfillment path")
        .pop_if_empty()
        .extend([admin_account, "codes", &code]);
    let url = fulfillment.to_string();
    let resp = s
        .http
        .send(UpstreamHttpRequest {
            method: "POST".into(),
            url,
            headers: BTreeMap::from([("Authorization".into(), format!("Bearer {access_token}"))]),
            body: None,
            multipart_file: None,
        })
        .await?;

    if !(200..300).contains(&resp.status) {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to verify code" }),
        ));
    }

    let parsed: Value = serde_json::from_slice(&resp.body)?;
    let offer_id = parsed["offerId"].clone();
    let identity_id = parsed["identityId"].clone();
    let details = parsed["details"].clone();

    let insert_doc = doc! {
        "code": &code,
        "accountId": &id,
        "offerId": account_bson(&offer_id),
        "identityId": account_bson(&identity_id),
        "details": account_bson(&details),
    };
    s.mongo.insert_one("key-codes", insert_doc).await?;

    if let Some(user_data) = s
        .mongo
        .find_one("epic", doc! { "accountId": { "$eq": &id } }, None)
        .await?
        && let Ok(discord_id) = user_data.get_str("discordId")
        && !discord_id.is_empty()
    {
        let path = format!(
            "/guilds/{DISCORD_DONATOR_GUILD_ID}/members/{discord_id}/roles/{DISCORD_DONATOR_ROLE_ID}"
        );
        let _ = s.discord.request("PUT", &path, None).await;
    }

    Ok(ok(&json!({ "message": "ok", "id": offer_id })))
}

async fn donate_key_get(State(s): State<AppState>, Path(code): Path<String>) -> Result<Response> {
    let Some(doc) = s
        .mongo
        .find_one("key-codes", doc! { "code": { "$eq": &code } }, None)
        .await?
    else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "Code not found" }),
        ));
    };
    let val = bson_doc_to_js_json(&doc);
    Ok(ok(&val["details"]))
}

// ============================================================================
// 2. Ownership (`src/routes/offers/data.ts` L1094-1126)
// ============================================================================

async fn offer_ownership(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let auth = authenticate_epic(&s, &headers).await?;
    let account_id = auth.account_id();

    let Some(product) = get_product(&s, &id).await? else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "message": "Product not found" }),
        ));
    };

    let product_id = product
        .get("_id")
        .map(bson_to_string_id)
        .unwrap_or_default();
    let is_owned = match account_id {
        Some(uid) if !uid.is_empty() => verify_game_ownership(&s, uid, &product_id).await,
        _ => false,
    };

    Ok(ok(&json!({ "isOwned": is_owned })))
}

// ============================================================================
// 3. Reviews (`src/routes/offers/reviews.ts` L88-296, L361-381)
// ============================================================================

fn validate_review_body(body: &Value) -> Result<()> {
    let rating_ok = body.get("rating").is_some_and(is_js_truthy);
    let title_ok = body.get("title").is_some_and(is_js_truthy);
    let content_ok = body.get("content").is_some_and(is_js_truthy);
    if !body.is_object() || !rating_ok || !title_ok || !content_ok {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "message": "Missing required fields" }),
        ));
    }
    Ok(())
}

fn extract_limited_tags(body: &Value) -> Result<Bson> {
    match &body["tags"] {
        Value::Array(tags) => Ok(Bson::Array(tags.iter().take(5).map(account_bson).collect())),
        Value::String(s) => Ok(Bson::String(String::from_utf16_lossy(
            &s.encode_utf16().take(5).collect::<Vec<_>>(),
        ))),
        _ => Err(Error::Internal),
    }
}

async fn offer_reviews_post(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let auth = authenticate_epic(&s, &headers).await?;
    let body = parse_json_body(&raw_body)?;
    validate_review_body(&body)?;

    let user_id = linked_account(&auth)?;

    let existing = s
        .mongo
        .find_one("reviews", doc! { "userId": &user_id, "id": &id }, None)
        .await?;
    if existing.is_some() {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "message": "User already reviewed this product" }),
        ));
    }

    let offer = s.mongo.find_one("offers", doc! { "id": &id }, None).await?;
    let now = (s.now)();
    let released = offer.as_ref().is_some_and(|o| offer_released(o, now));
    if !released {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "message": "Product not released" }),
        ));
    }

    let Some(product) = get_product(&s, &id).await? else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "message": "Product not found" }),
        ));
    };

    let product_id = product
        .get("_id")
        .map(bson_to_string_id)
        .unwrap_or_default();
    let is_owned = verify_game_ownership(&s, &user_id, &product_id).await;

    let now_bson = bson::DateTime::from_chrono(now);
    let mut review_doc = doc! {
        "id": &id,
        "rating": account_bson(&body["rating"]),
        "title": account_bson(&body["title"]),
        "content": account_bson(&body["content"]),
        "tags": extract_limited_tags(&body)?,
        "verified": is_owned,
        "userId": &user_id,
        "createdAt": now_bson,
        "updatedAt": now_bson,
    };
    if let Some(rec) = body.get("recommended") {
        review_doc.insert("recommended", account_bson(rec));
    }

    s.mongo.insert_one("reviews", review_doc).await?;
    Ok(super::json_response(
        StatusCode::CREATED,
        &json!({ "status": "ok" }),
    ))
}

async fn offer_reviews_patch(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let auth = authenticate_epic(&s, &headers).await?;
    let body = parse_json_body(&raw_body)?;
    validate_review_body(&body)?;

    let user_id = linked_account(&auth)?;

    let Some(product) = get_product(&s, &id).await? else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "message": "Product not found" }),
        ));
    };

    let product_id = product
        .get("_id")
        .map(bson_to_string_id)
        .unwrap_or_default();
    let is_owned = verify_game_ownership(&s, &user_id, &product_id).await;

    let owner = doc! { "userId": &user_id, "id": &id };
    // Another edit can advance the edition history between reading and writing.
    loop {
        let Some(old_review) = s.mongo.find_one("reviews", owner.clone(), None).await? else {
            return Err(json_err(
                StatusCode::NOT_FOUND,
                json!({ "message": "Review not found" }),
            ));
        };

        let mut filter = owner.clone();
        if let Some(mongo_id) = old_review.get("_id").filter(|id| **id != Bson::Null) {
            filter.insert("_id", mongo_id.clone());
        }
        let version = match old_review.get("editions") {
            Some(Bson::Array(history)) => doc! { "$size": history.len() as i64 },
            other => doc! { "$eq": other.cloned().unwrap_or(Bson::Null) },
        };
        filter.insert("editions", version);

        let mut editions = old_review
            .get_array("editions")
            .cloned()
            .unwrap_or_default();

        let mut old_entry = Document::new();
        for (src_key, dst_key) in [
            ("rating", "rating"),
            ("title", "title"),
            ("content", "content"),
            ("tags", "tags"),
            ("recommended", "recommended"),
            ("updatedAt", "createdAt"),
        ] {
            if let Some(val) = old_review.get(src_key) {
                old_entry.insert(dst_key, val.clone());
            }
        }
        editions.push(Bson::Document(old_entry));

        let now_bson = bson::DateTime::from_chrono((s.now)());
        let mut set_doc = doc! {
            "rating": account_bson(&body["rating"]),
            "title": account_bson(&body["title"]),
            "content": account_bson(&body["content"]),
            "tags": extract_limited_tags(&body)?,
            "verified": is_owned,
            "updatedAt": now_bson,
            "editions": editions,
        };
        if let Some(rec) = body.get("recommended") {
            set_doc.insert("recommended", account_bson(rec));
        }

        let modified = s
            .mongo
            .update_one("reviews", filter, doc! { "$set": set_doc }, false)
            .await?;

        if modified > 0 {
            break;
        }
    }

    Ok(ok(&json!({ "status": "ok" })))
}

async fn offer_reviews_delete(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let auth = authenticate_epic(&s, &headers).await?;
    let user_id = linked_account(&auth)?;

    let Some(_) = s
        .mongo
        .find_one("reviews", doc! { "userId": &user_id, "id": &id }, None)
        .await?
    else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "message": "Review not found" }),
        ));
    };

    s.mongo
        .delete_one("reviews", doc! { "userId": &user_id, "id": &id })
        .await?;

    Ok(ok(&json!({ "status": "ok" })))
}

async fn offer_reviews_permissions(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let auth = authenticate_epic(&s, &headers).await?;
    let user_id = linked_account(&auth)?;

    let existing = s
        .mongo
        .find_one("reviews", doc! { "userId": &user_id, "id": &id }, None)
        .await?;

    Ok(ok(&json!({ "canReview": existing.is_none() })))
}

// ============================================================================
// 4. Accounts (`src/routes/accounts.ts`)
// ============================================================================

async fn accounts_get(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let auth_header = header_str(&headers, "authorization")
        .ok_or_else(|| json_err(StatusCode::UNAUTHORIZED, json!({ "error": "Unauthorized" })))?;
    if !auth_header.starts_with("Bearer ") {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    }
    let token = auth_header.split(' ').nth(1).unwrap_or("");
    let user = verify_jwt(token, &s.config.jwt_secret)
        .ok_or_else(|| json_err(StatusCode::UNAUTHORIZED, json!({ "error": "Unauthorized" })))?;

    let encrypted_id = user
        .get("id")
        .and_then(Value::as_str)
        .ok_or(Error::Internal)?;
    let id = decrypt(encrypted_id, s.config.cookie_secret.as_bytes())?;

    let Some(google_info) = s
        .mongo
        .find_one("googleauths", doc! { "_id": &id }, None)
        .await?
    else {
        return Err(json_err(
            StatusCode::FORBIDDEN,
            json!({ "error": "User not found" }),
        ));
    };

    let access_token = google_info.get_str("access_token").unwrap_or("");
    let resp = s
        .http
        .send(UpstreamHttpRequest {
            method: "GET".into(),
            url: "https://www.googleapis.com/oauth2/v3/userinfo".into(),
            headers: BTreeMap::from([
                ("Authorization".into(), format!("Bearer {access_token}")),
                (
                    "Content-Type".into(),
                    "application/x-www-form-urlencoded".into(),
                ),
            ]),
            body: None,
            multipart_file: None,
        })
        .await?;

    let data: Value = serde_json::from_slice(&resp.body)?;
    if resp.status != 200 {
        let status = StatusCode::from_u16(resp.status).unwrap_or(StatusCode::BAD_GATEWAY);
        return Err(json_err(
            status,
            json!({ "error": "Failed to get account info", "details": data }),
        ));
    }

    Ok(ok(&json!({ "data": data })))
}

// ============================================================================
// 5. Users (`src/routes/users.ts`)
// ============================================================================

async fn verify_google_id_token(s: &AppState, token: &str) -> std::result::Result<Value, ()> {
    let jwks_url = s
        .config
        .google_jwks_url
        .as_deref()
        .unwrap_or("https://www.googleapis.com/oauth2/v3/certs");

    let audience = s
        .config
        .google_client_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or(())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[audience]);
    validation.set_issuer(&["https://accounts.google.com", "accounts.google.com"]);
    validation.set_required_spec_claims(&["aud", "iss", "exp", "sub"]);
    validation.validate_nbf = true;
    verify_provider_jwt(s, token, jwks_url, &validation).await
}

async fn get_discord_user(s: &AppState, token: &str) -> std::result::Result<Option<Value>, ()> {
    let resp = s
        .http
        .send(UpstreamHttpRequest {
            method: "GET".into(),
            url: "https://discord.com/api/v10/oauth2/@me".into(),
            headers: BTreeMap::from([("Authorization".into(), format!("Bearer {token}"))]),
            body: None,
            multipart_file: None,
        })
        .await
        .map_err(|_| ())?;
    if !(200..300).contains(&resp.status) {
        return Err(());
    }
    let payload: Value = serde_json::from_slice(&resp.body).map_err(|_| ())?;
    Ok(payload.get("user").filter(|v| v.is_object()).cloned())
}

async fn users_root() -> Response {
    ok(&json!({ "message": "Hello, World!" }))
}

// The first query is the model's projected exists check. If the account
// disappears before the full read, Node returns JSON null.
async fn existing_user(s: &AppState, id: &str) -> std::result::Result<Option<Value>, CoreError> {
    let filter = doc! { "id": id };
    if s.mongo
        .find_one("users", filter.clone(), Some(doc! {"_id":1}))
        .await?
        .is_none()
    {
        return Ok(None);
    }
    let row = s.mongo.find_one("users", filter, None).await?;
    Ok(Some(
        row.as_ref().map(bson_doc_to_js_json).unwrap_or(Value::Null),
    ))
}

fn new_user_doc(s: &AppState, body: &Value, keep_registration_date: bool) -> Document {
    let now = bson::DateTime::from_chrono((s.now)());
    let mut doc = account_document(body.as_object().unwrap());
    if !keep_registration_date || body["registrationDate"].is_null() {
        doc.insert("registrationDate", now);
    }
    doc.entry("createdAt".into()).or_insert(Bson::DateTime(now));
    doc.entry("updatedAt".into()).or_insert(Bson::DateTime(now));
    if body["_id"].is_null() {
        doc.insert("_id", (s.new_object_id)());
    }
    doc
}

async fn users_find_or_create(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let body = parse_json_body(&raw_body)?;
    let Some(token) = header_str(&headers, "authorization") else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Authorization header is required" }),
        ));
    };

    let jwt_token = token.replacen("Bearer ", "", 1);
    let Ok(claims) = verify_google_id_token(&s, &jwt_token).await else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid token" }),
        ));
    };

    let token_email = claims.get("email").and_then(Value::as_str);
    let token_sub = claims.get("sub").and_then(Value::as_str);

    if token_email != body.get("email").and_then(Value::as_str) {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Email does not match" }),
        ));
    }

    let Some(body_id) = body.get("id").and_then(Value::as_str) else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ID does not match" }),
        ));
    };
    if token_sub != Some(body_id) {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ID does not match" }),
        ));
    }

    if let Some(existing) = existing_user(&s, body_id)
        .await
        .map_err(|_| json_err(StatusCode::BAD_REQUEST, json!({ "error": "Invalid token" })))?
    {
        return Ok(ok(&existing));
    }

    let doc = new_user_doc(&s, &body, true);
    s.mongo
        .insert_one("users", doc.clone())
        .await
        .map_err(|_| json_err(StatusCode::BAD_REQUEST, json!({ "error": "Invalid token" })))?;

    Ok(ok(&bson_doc_to_js_json(&doc)))
}

async fn users_discord_get(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let Some(token) = header_str(&headers, "authorization") else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Authorization header is required" }),
        ));
    };

    let access_token = token.replacen("Bearer ", "", 1);
    let Ok(maybe_discord) = get_discord_user(&s, &access_token).await else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Discord" }),
        ));
    };

    let Some(discord_data) = maybe_discord else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "User information not found from Discord" }),
        ));
    };

    let Some(discord_id) = discord_data.get("id").and_then(Value::as_str) else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "User not found" }),
        ));
    };

    if let Some(user_doc) = existing_user(&s, discord_id).await.map_err(|_| {
        json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Discord" }),
        )
    })? {
        return Ok(ok(&user_doc));
    }

    Err(json_err(
        StatusCode::NOT_FOUND,
        json!({ "error": "User not found" }),
    ))
}

async fn users_discord_post(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let body = parse_json_body(&raw_body)?;
    let Some(token) = header_str(&headers, "authorization") else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Authorization header is required" }),
        ));
    };

    let access_token = token.replacen("Bearer ", "", 1);
    let Ok(maybe_discord) = get_discord_user(&s, &access_token).await else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Discord" }),
        ));
    };

    let Some(discord_data) = maybe_discord else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "User information not found from Discord" }),
        ));
    };

    let discord_id = discord_data.get("id").and_then(Value::as_str);
    let body_id = body.get("id").and_then(Value::as_str);
    if discord_id != body_id || discord_id.is_none() {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ID does not match" }),
        ));
    }
    let discord_id = discord_id.unwrap();

    if let Some(user_doc) = existing_user(&s, discord_id).await.map_err(|_| {
        json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Discord" }),
        )
    })? {
        return Ok(ok(&user_doc));
    }

    let doc = new_user_doc(&s, &body, false);
    s.mongo
        .insert_one("users", doc.clone())
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Failed to fetch user information from Discord" }),
            )
        })?;

    Ok(ok(&bson_doc_to_js_json(&doc)))
}

async fn users_epic_put(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    let Some(token) = header_str(&headers, "authorization") else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Authorization header is required" }),
        ));
    };

    let q = query(&uri);
    let Some(id) = q.get("id").filter(|v| !v.is_empty()).cloned() else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ID query parameter is required" }),
        ));
    };

    let access_token = token.replacen("Bearer ", "", 1);
    let Ok(maybe_discord) = get_discord_user(&s, &access_token).await else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Epic Games" }),
        ));
    };
    let Some(discord_data) = maybe_discord else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "User information not found from Discord" }),
        ));
    };
    let discord_id = discord_data
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| json_err(StatusCode::NOT_FOUND, json!({"error":"User not found"})))?;

    let user = s
        .mongo
        .find_one("users", doc! { "id": discord_id }, Some(doc! { "_id": 1 }))
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Failed to fetch user information from Epic Games" }),
            )
        })?;
    if user.is_none() {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "User not found" }),
        ));
    }

    let Ok(maybe_epic) = s.epic.get_user(&id).await else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Epic Games" }),
        ));
    };
    let Some(epic_profile) = maybe_epic else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "Epic user not found" }),
        ));
    };

    let epic_account_id = epic_profile
        .get("epicAccountId")
        .and_then(Value::as_str)
        .unwrap_or(&id);

    let still_exists = s
        .mongo
        .find_one("users", doc! {"id":discord_id}, None)
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({"error":"Failed to fetch user information from Epic Games"}),
            )
        })?
        .is_some();
    if !still_exists {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({"error":"User not found"}),
        ));
    }
    s.mongo
        .update_one(
            "users",
            doc! { "id": discord_id },
            doc! { "$set": { "epicId": epic_account_id } },
            false,
        )
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Failed to fetch user information from Epic Games" }),
            )
        })?;

    Ok(ok(&json!({ "success": true })))
}

async fn users_epic_delete(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let Some(token) = header_str(&headers, "authorization") else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Authorization header is required" }),
        ));
    };

    let access_token = token.replacen("Bearer ", "", 1);
    let Ok(maybe_discord) = get_discord_user(&s, &access_token).await else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to fetch user information from Epic Games" }),
        ));
    };
    let Some(discord_data) = maybe_discord else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "User information not found from Discord" }),
        ));
    };
    let discord_id = discord_data
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| json_err(StatusCode::NOT_FOUND, json!({"error":"User not found"})))?;

    let user = s
        .mongo
        .find_one("users", doc! { "id": discord_id }, Some(doc! { "_id": 1 }))
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Failed to fetch user information from Epic Games" }),
            )
        })?;
    if user.is_none() {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "User not found" }),
        ));
    }

    let still_exists = s
        .mongo
        .find_one("users", doc! {"id":discord_id}, None)
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({"error":"Failed to fetch user information from Epic Games"}),
            )
        })?
        .is_some();
    if !still_exists {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({"error":"User not found"}),
        ));
    }
    s.mongo
        .update_one(
            "users",
            doc! { "id": discord_id },
            doc! { "$set": { "epicId": Bson::Null } },
            false,
        )
        .await
        .map_err(|_| {
            json_err(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Failed to fetch user information from Epic Games" }),
            )
        })?;

    Ok(ok(&json!({ "success": true })))
}

async fn users_check_epic(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let Some(id) = q.get("id").filter(|v| !v.is_empty()).cloned() else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ID query parameter is required" }),
        ));
    };

    let err_fn = |_| {
        json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Failed to check Epic account" }),
        )
    };

    if s.mongo
        .find_one("users", doc! { "epicId": &id }, None)
        .await
        .map_err(err_fn)?
        .is_some()
    {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Epic account already associated" }),
        ));
    }

    let profile = s.epic.get_user(&id).await.map_err(err_fn)?;
    match profile {
        Some(p) => Ok(ok(&json!({ "profile": p }))),
        None => Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "message": "Epic account does not exist" }),
        )),
    }
}

// ============================================================================
// 6. Users Service (`src/routes/users-service.ts`)
// ============================================================================

struct UsersServiceAuth {
    sub: String,
    access_token: String,
}

async fn authenticate_users_service(s: &AppState, headers: &HeaderMap) -> Result<UsersServiceAuth> {
    let Some(authorization) = header_str(headers, "authorization") else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    };
    if !authorization.starts_with("Bearer ") {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Invalid authorization header" }),
        ));
    }

    let supplied = &authorization["Bearer ".len()..];
    let token = supplied.strip_prefix("eg1~").unwrap_or(supplied);
    let claims = decode_jwt_payload(token)
        .ok_or_else(|| json_err(StatusCode::UNAUTHORIZED, json!({ "error": "Invalid JWT" })))?;

    let Some(sub) = claims
        .get("sub")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
    else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Invalid JWT" }),
        ));
    };

    if let Some(exp) = claims.get("exp").and_then(Value::as_f64) {
        let now_ms = (s.now)().timestamp_millis() as f64;
        if exp * 1000.0 < now_ms {
            return Err(json_err(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "JWT is expired" }),
            ));
        }
    }

    let access_token = format!("eg1~{token}");
    let (status, info) = post_token_info(s, supplied)
        .await
        .map_err(|_| json_err(StatusCode::UNAUTHORIZED, json!({"error":"Invalid JWT"})))?;
    if !(200..300).contains(&status)
        || info["active"] != true
        || info["account_id"].as_str() != Some(&sub)
    {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({"error":"Invalid JWT"}),
        ));
    }
    Ok(UsersServiceAuth { sub, access_token })
}

async fn users_service_root(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let _ = authenticate_users_service(&s, &headers).await?;
    Ok(ok(&json!({ "message": "Hello, World!" })))
}

async fn users_service_playtime(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let auth = authenticate_users_service(&s, &headers).await?;
    let body = parse_json_body(&raw_body)?;
    let entries = body.as_array().ok_or(Error::Internal)?;

    for entry in entries {
        let Some(account_id) = entry.get("accountId").and_then(Value::as_str) else {
            continue;
        };
        let Some(artifact_id) = entry
            .get("artifactId")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        if account_id != auth.sub {
            continue;
        }
        let total_time = entry
            .get("totalTime")
            .map(account_bson)
            .unwrap_or(Bson::Null);
        s.mongo
            .update_one(
                "playtime",
                doc! { "accountId": account_id, "artifactId": artifact_id },
                doc! { "$set": { "totalTime": total_time } },
                true,
            )
            .await?;
    }

    Ok(ok(&json!({ "message": "ok" })))
}

async fn users_service_ownership(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let auth = authenticate_users_service(&s, &headers).await?;
    let body = parse_json_body(&raw_body)?;
    let entries = body.as_array().ok_or(Error::Internal)?;

    let offers: Vec<Value> = entries
        .iter()
        .filter_map(|o| {
            let id = o
                .get("id")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())?;
            let ns = o
                .get("namespace")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())?;
            Some(json!({ "offerId": id, "namespace": ns }))
        })
        .collect();

    const QUERY: &str = r#"
        query getOffersValidation($offers: [OfferToValidate]!) {
          Entitlements {
            cartOffersValidation(offerParams: $offers) {
              conflictingOffers {
                offerId
                namespace
                conflictingOffers {
                  namespace
                  offerId
                }
              }
              missingPrerequisites {
                namespace
                offerId
                missingPrerequisiteItems {
                  itemId
                  namespace
                }
              }
              fullyOwnedOffers {
                namespace
                offerId
              }
              possiblePartialUpgradeOffers {
                namespace
                offerId
              }
              unablePartiallyUpgradeOffers {
                namespace
                offerId
              }
            }
          }
        }
      "#;

    let payload = egdata_core::v1::serialization::node_json(&json!({
        "query": QUERY,
        "variables": { "offers": offers },
        "operationName": "getOffersValidation",
    }))
    .into_bytes();

    let req = UpstreamHttpRequest {
        method: "POST".into(),
        url: EPIC_GRAPHQL_URL.into(),
        headers: BTreeMap::from([
            ("Accept".into(), "application/json".into()),
            ("Accept-Language".into(), "en-US,en;q=0.9".into()),
            ("Content-Type".into(), "application/json".into()),
            ("Origin".into(), "https://store.epicgames.com".into()),
            (
                "Referer".into(),
                "https://store.epicgames.com/en-US/".into(),
            ),
            ("User-Agent".into(), EPIC_STORE_USER_AGENT.into()),
            (
                "Authorization".into(),
                format!("Bearer {}", auth.access_token),
            ),
        ]),
        body: Some(payload),
        multipart_file: None,
    };

    let result = match s.http.send(req).await {
        Ok(resp) => match serde_json::from_slice::<Value>(&resp.body) {
            Ok(val) => {
                if (200..300).contains(&resp.status) {
                    val.pointer("/data/Entitlements/cartOffersValidation")
                        .or_else(|| val.pointer("/Entitlements/cartOffersValidation"))
                        .cloned()
                        .unwrap_or(Value::Null)
                } else {
                    val.get("errors").cloned().unwrap_or(Value::Null)
                }
            }
            Err(_) => Value::Null,
        },
        Err(_) => Value::Null,
    };

    Ok(ok(&result))
}

// ============================================================================
// 7. Push notifications (`src/routes/push.ts`)
// ============================================================================

fn authenticate_push_user(headers: &HeaderMap) -> Result<String> {
    header_str(headers, "x-api-key")
        .map(str::to_string)
        .ok_or_else(|| {
            json_err(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "API key required" }),
            )
        })
}

fn authenticate_push_admin(s: &AppState, headers: &HeaderMap) -> Result<()> {
    let api_key = header_str(headers, "x-api-key");
    let auth_key = header_str(headers, "authorization")
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v))
        .filter(|v| !v.is_empty());
    let Some(provided) = api_key.or(auth_key) else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "API key required for this operation" }),
        ));
    };

    let Some(valid_key) = s
        .config
        .push_admin_api_key
        .as_deref()
        .filter(|v| !v.is_empty())
    else {
        return Err(json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Push notifications admin API not configured" }),
        ));
    };

    if !crate::middleware::origin_auth::sha256_secure_eq(provided, valid_key) {
        return Err(json_err(
            StatusCode::FORBIDDEN,
            json!({ "error": "Invalid API key" }),
        ));
    }

    Ok(())
}

fn validate_push_subscription(body: &Value) -> std::result::Result<(String, String, String), ()> {
    let obj = body.as_object().ok_or(())?;
    let endpoint = obj
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(())?
        .to_string();
    let keys = obj.get("keys").and_then(Value::as_object).ok_or(())?;
    let p256dh = keys
        .get("p256dh")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(())?
        .to_string();
    let auth = keys
        .get("auth")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(())?
        .to_string();
    Ok((endpoint, p256dh, auth))
}

fn validate_topic_subscription(body: &Value) -> std::result::Result<(&str, &[Value]), ()> {
    let id = body["subscriptionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or(())?;
    let topics = body["topics"].as_array().ok_or(())?;
    Ok((id, topics))
}

// Set and includes compare JavaScript objects by identity. Objects decoded
// from separate JSON or database values are always distinct.
fn primitive_topic_key(topic: &Value) -> Option<String> {
    if topic.is_array() || topic.is_object() {
        return None;
    }
    Some(egdata_core::v1::serialization::node_json(topic))
}

fn validate_send_notification(body: &Value) -> std::result::Result<(String, Value), ()> {
    let obj = body.as_object().ok_or(())?;
    let topic = obj
        .get("topic")
        .and_then(Value::as_str)
        .ok_or(())?
        .to_string();
    let notif = obj
        .get("notification")
        .and_then(Value::as_object)
        .ok_or(())?;
    let title = notif.get("title").and_then(Value::as_str).ok_or(())?;
    let body_text = notif.get("body").and_then(Value::as_str).ok_or(())?;
    if let Some(img) = notif.get("image")
        && !img.is_string()
    {
        return Err(());
    }

    let mut out_notif = Map::new();
    out_notif.insert("title".into(), Value::String(title.to_string()));
    out_notif.insert("body".into(), Value::String(body_text.to_string()));

    for opt_key in ["icon", "badge"] {
        if let Some(val) = notif.get(opt_key) {
            let s = val.as_str().ok_or(())?;
            out_notif.insert(opt_key.into(), Value::String(s.to_string()));
        }
    }

    if let Some(actions_val) = notif.get("actions") {
        let actions_arr = actions_val.as_array().ok_or(())?;
        let mut parsed_actions = Vec::with_capacity(actions_arr.len());
        for act in actions_arr {
            let act_obj = act.as_object().ok_or(())?;
            let action_inner = act_obj.get("action").and_then(Value::as_object).ok_or(())?;
            let action_type = action_inner.get("type").and_then(Value::as_str).ok_or(())?;
            if action_type != "open" && action_type != "close" {
                return Err(());
            }
            let mut clean_inner = Map::new();
            clean_inner.insert("type".into(), Value::String(action_type.to_string()));
            if let Some(url_val) = action_inner.get("url") {
                let u = url_val.as_str().ok_or(())?;
                clean_inner.insert("url".into(), Value::String(u.to_string()));
            }

            let action_title = act_obj.get("title").and_then(Value::as_str).ok_or(())?;
            let mut clean_act = Map::new();
            clean_act.insert("action".into(), Value::Object(clean_inner));
            clean_act.insert("title".into(), Value::String(action_title.to_string()));
            if let Some(icon_val) = act_obj.get("icon") {
                let i = icon_val.as_str().ok_or(())?;
                clean_act.insert("icon".into(), Value::String(i.to_string()));
            }
            parsed_actions.push(Value::Object(clean_act));
        }
        out_notif.insert("actions".into(), Value::Array(parsed_actions));
    }

    Ok((topic, Value::Object(out_notif)))
}

fn vapid_configured(s: &AppState) -> bool {
    s.config
        .vapid_public_key
        .as_deref()
        .is_some_and(|v| !v.is_empty())
        && s.config
            .vapid_private_key
            .as_deref()
            .is_some_and(|v| !v.is_empty())
}

async fn dispatch_push_notifications(
    s: &AppState,
    subscriptions: &[Value],
    notification: &Value,
) -> (usize, usize, usize, Vec<Value>) {
    let payload = serde_json::to_vec(notification).unwrap_or_default();
    let mut successful = 0usize;
    let mut failed = 0usize;
    let mut removed = 0usize;
    let mut results = Vec::with_capacity(subscriptions.len());

    for sub in subscriptions {
        let sub_id = sub.get("id").and_then(Value::as_str).unwrap_or("");
        if sub["keys"].is_null() {
            results.push(json!({"success":false,"error":"Promise rejected"}));
            continue;
        }
        let push_sub = json!({
            "id": sub_id,
            "endpoint": sub["endpoint"],
            "keys": {
                "p256dh": sub["keys"]["p256dh"],
                "auth": sub["keys"]["auth"],
            },
        });
        match s.web_push.send_notification(&push_sub, &payload).await {
            Ok(()) => {
                successful += 1;
                results.push(json!({ "success": true, "subscriptionId": sub_id }));
            }
            Err(CoreError::NotFound(_)) => {
                if s.mongo
                    .delete_one("pushsubscriptions", doc! { "id": sub_id })
                    .await
                    .is_err()
                {
                    results.push(json!({"success":false,"error":"Promise rejected"}));
                    continue;
                }
                failed += 1;
                removed += 1;
                results.push(json!({
                    "success": false,
                    "subscriptionId": sub_id,
                    "removed": true,
                    "error": "Subscription expired",
                }));
            }
            Err(err) => {
                failed += 1;
                let msg = err.to_string();
                let error_text = if msg.is_empty() {
                    "Unknown error".to_string()
                } else {
                    msg
                };
                results.push(json!({
                    "success": false,
                    "subscriptionId": sub_id,
                    "error": error_text,
                }));
            }
        }
    }

    (successful, failed, removed, results)
}

async fn push_subscribe_post(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let fail = || {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to subscribe" }),
        )
    };
    let body = parse_json_body(&raw_body).map_err(|_| fail())?;
    let (endpoint, p256dh, auth) = validate_push_subscription(&body).map_err(|()| fail())?;

    if let Some(existing) = s
        .mongo
        .find_one(
            "pushsubscriptions",
            doc! { "userId": &user_id, "endpoint": &endpoint },
            None,
        )
        .await
        .map_err(|_| fail())?
    {
        let mut response = json!({});
        if let Some(id) = existing.get("id") {
            response["id"] = bson_to_js_json(id);
        }
        response["message"] = "Subscription already exists".into();
        return Ok(ok(&response));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now_bson = bson::DateTime::from_chrono((s.now)());
    let doc = doc! {
        "id": &id,
        "userId": &user_id,
        "endpoint": &endpoint,
        "keys": {
            "p256dh": &p256dh,
            "auth": &auth,
        },
        "topics": [],
        "createdAt": now_bson,
        "updatedAt": now_bson,
    };
    s.mongo
        .insert_one("pushsubscriptions", doc)
        .await
        .map_err(|_| fail())?;

    Ok(ok(&json!({
        "id": id,
        "message": "Successfully subscribed to push notifications",
    })))
}

async fn push_subscribe_get(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let subs = many(
        &s,
        "pushsubscriptions",
        doc! { "userId": &user_id },
        MongoFindOptions {
            projection: Some(doc! { "id": 1, "topics": 1, "createdAt": 1, "updatedAt": 1 }),
            ..Default::default()
        },
    )
    .await
    .map_err(|_| {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to check subscription status" }),
        )
    })?;

    Ok(ok(&json!({
        "isSubscribed": !subs.is_empty(),
        "subscriptionCount": subs.len(),
        "subscriptions": subs,
    })))
}

async fn push_unsubscribe_delete(
    State(s): State<AppState>,
    Path(subscription_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let deleted = s
        .mongo
        .delete_one(
            "pushsubscriptions",
            doc! { "id": subscription_id, "userId": &user_id },
        )
        .await
        .map_err(|_| {
            json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Failed to unsubscribe" }),
            )
        })?;

    if deleted == 0 {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "Subscription not found" }),
        ));
    }

    Ok(ok(&json!({ "message": "Successfully unsubscribed" })))
}

async fn push_topics_subscribe(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let fail = || {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to subscribe to topics" }),
        )
    };
    let body = parse_json_body(&raw_body).map_err(|_| fail())?;
    let (subscription_id, topics) = validate_topic_subscription(&body).map_err(|()| fail())?;

    let Some(sub_doc) = s
        .mongo
        .find_one(
            "pushsubscriptions",
            doc! { "id": subscription_id, "userId": &user_id },
            None,
        )
        .await
        .map_err(|_| fail())?
    else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "Subscription not found" }),
        ));
    };

    let sub_val = bson_doc_to_js_json(&sub_doc);
    let characters;
    let existing = match &sub_val["topics"] {
        Value::Array(values) => values,
        Value::String(value) => {
            characters = value
                .chars()
                .map(|ch| Value::String(ch.to_string()))
                .collect();
            &characters
        }
        _ => return Err(fail()),
    };
    let mut seen = HashSet::new();
    let unique_topics: Vec<&Value> = existing
        .iter()
        .chain(topics)
        .filter(|topic| primitive_topic_key(topic).is_none_or(|key| seen.insert(key)))
        .collect();
    let stored = Bson::Array(unique_topics.iter().map(|v| account_bson(v)).collect());

    let now_bson = bson::DateTime::from_chrono((s.now)());
    s.mongo
        .update_one(
            "pushsubscriptions",
            doc! { "id": subscription_id, "userId": &user_id },
            doc! { "$set": { "topics": stored, "updatedAt": now_bson } },
            false,
        )
        .await
        .map_err(|_| fail())?;

    Ok(ok(&json!({
        "message": "Successfully subscribed to topics",
        "topics": unique_topics,
    })))
}

async fn push_topics_unsubscribe(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let fail = || {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to unsubscribe from topics" }),
        )
    };
    let body = parse_json_body(&raw_body).map_err(|_| fail())?;
    let (subscription_id, topics) = validate_topic_subscription(&body).map_err(|()| fail())?;

    let Some(sub_doc) = s
        .mongo
        .find_one(
            "pushsubscriptions",
            doc! { "id": subscription_id, "userId": &user_id },
            None,
        )
        .await
        .map_err(|_| fail())?
    else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "Subscription not found" }),
        ));
    };

    let remove_set: HashSet<String> = topics.iter().filter_map(primitive_topic_key).collect();
    let sub_val = bson_doc_to_js_json(&sub_doc);
    let existing = sub_val["topics"].as_array().ok_or_else(fail)?;
    let updated_topics: Vec<&Value> = existing
        .iter()
        .filter(|topic| primitive_topic_key(topic).is_none_or(|key| !remove_set.contains(&key)))
        .collect();
    let stored = Bson::Array(updated_topics.iter().map(|v| account_bson(v)).collect());

    let now_bson = bson::DateTime::from_chrono((s.now)());
    s.mongo
        .update_one(
            "pushsubscriptions",
            doc! { "id": subscription_id, "userId": &user_id },
            doc! { "$set": { "topics": stored, "updatedAt": now_bson } },
            false,
        )
        .await
        .map_err(|_| fail())?;

    Ok(ok(&json!({
        "message": "Successfully unsubscribed from topics",
        "topics": updated_topics,
    })))
}

async fn push_subscriptions_list(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let subscriptions = many(
        &s,
        "pushsubscriptions",
        doc! { "userId": &user_id },
        MongoFindOptions {
            projection: Some(
                doc! { "id": 1, "endpoint": 1, "topics": 1, "createdAt": 1, "updatedAt": 1 },
            ),
            ..Default::default()
        },
    )
    .await
    .map_err(|_| {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to fetch subscriptions" }),
        )
    })?;

    Ok(ok(&json!({ "subscriptions": subscriptions })))
}

async fn push_subscriptions_get(
    State(s): State<AppState>,
    Path(subscription_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let user_id = authenticate_push_user(&headers)?;
    let sub = s
        .mongo
        .find_one(
            "pushsubscriptions",
            doc! { "id": subscription_id, "userId": &user_id },
            Some(doc! { "id": 1, "topics": 1, "createdAt": 1, "updatedAt": 1 }),
        )
        .await
        .map_err(|_| {
            json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Failed to fetch subscription" }),
            )
        })?;

    let Some(doc) = sub else {
        return Err(json_err(
            StatusCode::NOT_FOUND,
            json!({ "error": "Subscription not found" }),
        ));
    };

    Ok(ok(&json!({ "subscription": bson_doc_to_js_json(&doc) })))
}

async fn push_send(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    authenticate_push_admin(&s, &headers)?;
    let fail = || {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to send notification" }),
        )
    };
    let body = parse_json_body(&raw_body).map_err(|_| fail())?;
    let (topic, notification) = validate_send_notification(&body).map_err(|()| fail())?;

    if !vapid_configured(&s) {
        return Err(json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Push notifications not configured" }),
        ));
    }

    let exact = many(
        &s,
        "pushsubscriptions",
        doc! { "topics": &topic },
        Default::default(),
    )
    .await
    .map_err(|_| fail())?;

    let parts: Vec<&str> = topic.split(':').collect();
    let wildcard_patterns: Vec<String> = (1..parts.len())
        .map(|i| format!("{}:*", parts[..i].join(":")))
        .collect();

    let wildcard = if wildcard_patterns.is_empty() {
        Vec::new()
    } else {
        many(
            &s,
            "pushsubscriptions",
            doc! { "topics": { "$in": wildcard_patterns } },
            Default::default(),
        )
        .await
        .map_err(|_| fail())?
    };

    let mut seen_ids = HashSet::new();
    let mut subscriptions = Vec::new();
    for sub in exact.into_iter().chain(wildcard) {
        let id_str = sub
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if seen_ids.insert(id_str) {
            subscriptions.push(sub);
        }
    }

    if subscriptions.is_empty() {
        return Ok(ok(&json!({
            "message": "No subscribers found for this topic",
            "topic": topic,
            "subscriberCount": 0,
        })));
    }

    let (successful, failed, removed, results) =
        dispatch_push_notifications(&s, &subscriptions, &notification).await;

    Ok(ok(&json!({
        "message": "Notification sending completed",
        "topic": topic,
        "totalSubscribers": subscriptions.len(),
        "successful": successful,
        "failed": failed,
        "removed": removed,
        "results": results,
    })))
}

async fn push_send_to_user(
    State(s): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    authenticate_push_admin(&s, &headers)?;
    let fail = || {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Failed to send notification" }),
        )
    };
    let body = parse_json_body(&raw_body).map_err(|_| fail())?;
    if body.is_null() {
        return Err(fail());
    }
    let Some(user_id) = body
        .get("userId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
    else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid userId" }),
        ));
    };
    let Some(notification) = body
        .get("notification")
        .filter(|v| v.is_object() || v.is_array())
    else {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid notification" }),
        ));
    };

    if !vapid_configured(&s) {
        return Err(json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Push notifications not configured" }),
        ));
    }

    let subscriptions = many(
        &s,
        "pushsubscriptions",
        doc! { "userId": &user_id },
        Default::default(),
    )
    .await
    .map_err(|_| fail())?;

    if subscriptions.is_empty() {
        return Ok(ok(&json!({
            "message": "No subscriptions found for this user",
            "userId": user_id,
            "subscriberCount": 0,
        })));
    }

    let (successful, failed, removed, results) =
        dispatch_push_notifications(&s, &subscriptions, notification).await;

    Ok(ok(&json!({
        "message": "Notification sending completed",
        "userId": user_id,
        "totalSubscriptions": subscriptions.len(),
        "successful": successful,
        "failed": failed,
        "removed": removed,
        "results": results,
    })))
}

async fn push_vapid_public_key(State(s): State<AppState>) -> Result<Response> {
    let Some(key) = s
        .config
        .vapid_public_key
        .as_deref()
        .filter(|v| !v.is_empty())
    else {
        return Err(json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "VAPID public key not configured" }),
        ));
    };

    Ok(ok(&json!({ "publicKey": key })))
}

async fn push_topics_stats(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let _user_id = authenticate_push_user(&headers)?;
    let stats = s
        .mongo
        .aggregate(
            "pushsubscriptions",
            vec![
                doc! { "$unwind": "$topics" },
                doc! { "$group": { "_id": "$topics", "count": { "$sum": 1 } } },
                doc! { "$sort": { "count": -1 } },
            ],
        )
        .await
        .map_err(|_| {
            json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Failed to fetch topic statistics" }),
            )
        })?;

    let topics: Vec<Value> = stats
        .iter()
        .map(|row| {
            let mut stat = json!({});
            if let Some(topic) = row.get("_id") {
                stat["topic"] = bson_to_js_json(topic);
            }
            if let Some(count) = row.get("count") {
                stat["subscriberCount"] = bson_to_js_json(count);
            }
            stat
        })
        .collect();

    Ok(ok(&json!({ "topics": topics })))
}

// ============================================================================
// 8. Launcher (`src/routes/launcher.ts`)
// ============================================================================

async fn authenticate_launcher(s: &AppState, headers: &HeaderMap) -> Result<()> {
    let cookies = parse_cookies(cookie_header(headers));
    let raw_auth = header_str(headers, "authorization")
        .map(str::to_string)
        .or_else(|| {
            cookies
                .get("EGDATA_AUTH")
                .filter(|v| !v.is_empty())
                .cloned()
        })
        .ok_or_else(|| {
            json_err(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "Missing EPIC_AUTH header or cookie" }),
            )
        })?;

    let token = raw_auth.strip_prefix("Bearer ").unwrap_or(&raw_auth);

    let Some(pem) = s
        .config
        .jwt_public_key_pem
        .as_deref()
        .filter(|v| !v.is_empty())
    else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Missing JWT_PUBLIC_KEY env variable" }),
        ));
    };

    let invalid = || json_err(StatusCode::UNAUTHORIZED, json!({"error":"Invalid JWT"}));
    let decoding_key = DecodingKey::from_rsa_pem(pem.as_bytes()).map_err(|_| invalid())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_aud = false;
    validation.validate_nbf = true;
    let claims = decode::<Value>(token, &decoding_key, &validation)
        .map_err(|_| invalid())?
        .claims;
    if claims["client_id"].as_str() != Some(LAUNCHER_CLIENT_ID) {
        return Err(invalid());
    }
    Ok(())
}

async fn launcher_fetch(s: &AppState, url: String, err_msg: &str) -> Result<Response> {
    let access_token = launcher_access_token(s).await?;
    let resp = s
        .http
        .send(UpstreamHttpRequest {
            method: "GET".into(),
            url,
            headers: BTreeMap::from([
                ("Content-Type".into(), "application/json".into()),
                ("Authorization".into(), format!("Bearer {access_token}")),
            ]),
            body: None,
            multipart_file: None,
        })
        .await?;

    if !(200..300).contains(&resp.status) {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": err_msg }),
        ));
    }

    let data: Value = serde_json::from_slice(&resp.body)?;
    Ok(cache_header(ok(&data), ONE_MINUTE))
}

fn launcher_url(id: &str, resource: Option<&str>, uri: Option<&Uri>) -> Result<String> {
    if matches!(id, "." | "..") {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({"error":"Invalid sandbox id"}),
        ));
    }
    let mut url = url::Url::parse(LAUNCHER_BASE_URL).expect("launcher endpoint is a URL");
    {
        let mut path = url
            .path_segments_mut()
            .expect("launcher endpoint supports path segments");
        if let Some(resource) = resource {
            path.extend(["namespace", id, resource]);
        } else {
            path.extend(["namespaces", id]);
        }
    }
    if let Some(query) = uri.and_then(Uri::query).filter(|v| !v.is_empty()) {
        url.query_pairs_mut()
            .extend_pairs(url::form_urlencoded::parse(query.as_bytes()));
    }
    Ok(url.into())
}

async fn launcher_sandbox(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    authenticate_launcher(&s, &headers).await?;
    launcher_fetch(
        &s,
        launcher_url(&id, None, None)?,
        "Failed to fetch sandbox",
    )
    .await
}

async fn launcher_sandbox_items(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    authenticate_launcher(&s, &headers).await?;
    let url = launcher_url(&id, Some("items"), Some(&uri))?;
    launcher_fetch(&s, url, "Failed to fetch sandbox items").await
}

async fn launcher_sandbox_offers(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    authenticate_launcher(&s, &headers).await?;
    let url = launcher_url(&id, Some("offers"), Some(&uri))?;
    launcher_fetch(&s, url, "Failed to fetch sandbox offers").await
}

// ============================================================================
// 9. Admin (`src/routes/admin.ts`)
// ============================================================================

fn role_allows_method(role: &str, method: &Method) -> bool {
    let m = method.as_str();
    match role {
        "admin" => matches!(m, "GET" | "POST" | "PUT" | "DELETE" | "PATCH"),
        "editor" => matches!(m, "GET" | "PUT" | "PATCH"),
        "viewer" => m == "GET",
        _ => false,
    }
}

fn decode_base64_segment(segment: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(segment)
        .or_else(|_| STANDARD_NO_PAD.decode(segment))
        .or_else(|_| URL_SAFE.decode(segment))
        .or_else(|_| URL_SAFE_NO_PAD.decode(segment))
        .ok()
}

enum AdminAuthOutcome {
    Allowed(String),
    ForbiddenResponse(Response),
}

async fn authenticate_admin(
    s: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<AdminAuthOutcome> {
    let cookies = parse_cookies(cookie_header(headers));
    let Some(auth_cookie) = cookies.get("EGDATA_AUTH").filter(|v| !v.is_empty()) else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    };

    let parts: Vec<&str> = auth_cookie.split('.').collect();
    if parts.len() != 2 {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    }

    let decoded_bytes = decode_base64_segment(parts[0]).ok_or(Error::Internal)?;
    let decoded: Value = serde_json::from_slice(&decoded_bytes)?;
    let account_id_ok = decoded
        .pointer("/user/accountId")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty());
    let access_token = decoded
        .pointer("/user/accessToken")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());

    let Some(access_token) = access_token.filter(|_| account_id_ok) else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    };

    let (status, token_info) = post_token_info(s, access_token)
        .await
        .map_err(|()| Error::Internal)?;

    if !(200..300).contains(&status) {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    }

    let info_account_id = token_info
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let active = token_info.get("active").and_then(Value::as_bool) == Some(true);
    let Some(info_account_id) = info_account_id.filter(|_| active) else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    };

    let Some(user) = s
        .mongo
        .find_one("epic", doc! { "accountId": info_account_id }, None)
        .await?
    else {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Unauthorized" }),
        ));
    };

    let role = user.get_str("role").unwrap_or("");
    if !role_allows_method(role, method) {
        return Ok(AdminAuthOutcome::ForbiddenResponse(ok(&json!({
            "message": "Unauthorized",
        }))));
    }

    Ok(AdminAuthOutcome::Allowed(role.to_string()))
}

async fn admin_root(
    State(s): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response> {
    match authenticate_admin(&s, &headers, &method).await? {
        AdminAuthOutcome::Allowed(role) => Ok(ok(&json!({ "role": role }))),
        AdminAuthOutcome::ForbiddenResponse(resp) => Ok(resp),
    }
}

fn admin_offer_id(body: &Value) -> Result<Bson> {
    // Scalar IDs preserve the legacy Mongo type without accepting query operators.
    if body.is_null() {
        return Err(Error::Internal);
    }
    let id = &body["id"];
    if !is_js_truthy(id) || id.is_array() || id.is_object() {
        return Err(json_err(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Missing id" }),
        ));
    }
    Ok(account_bson(id))
}

async fn admin_offers_post(
    State(s): State<AppState>,
    method: Method,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    if let AdminAuthOutcome::ForbiddenResponse(resp) =
        authenticate_admin(&s, &headers, &method).await?
    {
        return Ok(resp);
    }

    let body = parse_json_body(&raw_body)?;
    let id = admin_offer_id(&body)?;

    if one(&s, "offers", doc! { "id": &id }).await?.is_some() {
        return Ok(ok(&json!({ "message": "Offer already exists" })));
    }

    let doc = account_document(body.as_object().unwrap());
    s.mongo.insert_one("offers", doc).await?;
    Ok(ok(&json!({ "message": "Offer created" })))
}

async fn admin_offers_patch(
    State(s): State<AppState>,
    method: Method,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Response> {
    if let AdminAuthOutcome::ForbiddenResponse(resp) =
        authenticate_admin(&s, &headers, &method).await?
    {
        return Ok(resp);
    }

    let body = parse_json_body(&raw_body)?;
    let id = admin_offer_id(&body)?;

    if one(&s, "offers", doc! { "id": &id }).await?.is_none() {
        return Ok(ok(&json!({ "message": "Offer not found" })));
    }

    let set_doc = account_document(body.as_object().unwrap());
    s.mongo
        .update_one("offers", doc! { "id": id }, doc! { "$set": set_doc }, false)
        .await?;
    Ok(ok(&json!({ "message": "Offer updated" })))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::{legacy, middleware::test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use axum::body::Body;
    use chrono::TimeZone;
    use egdata_core::{
        ports::{
            DiscordPort, EpicStorePort, MongoFindOptions, MongoStorePort, SessionVerifierPort,
            UpstreamHttpPort, UpstreamHttpRequest, UpstreamHttpResponse, VerifiedSession,
            WebPushPort,
        },
        sitemap::encrypt_with_iv,
    };
    use http_body_util::BodyExt;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use tower::ServiceExt;

    mod dependency_failures {
        include!("account_admin/dependency_failures.rs");
    }
    mod oracle {
        include!("account_admin/oracle.rs");
    }

    fn fixed_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 18, 12, 0, 0).unwrap()
    }

    type CoreRes<T> = std::result::Result<T, CoreError>;
    type FindQueue<T> = Arc<Mutex<BTreeMap<String, VecDeque<CoreRes<T>>>>>;
    type UpdateLog = Arc<Mutex<Vec<(String, Document, Document, bool)>>>;

    #[derive(Clone, Default)]
    struct MockMongo {
        find_one_map: FindQueue<Option<Document>>,
        find_many_map: FindQueue<Vec<Document>>,
        aggregate_res: Arc<Mutex<VecDeque<CoreRes<Vec<Document>>>>>,
        inserted: Arc<Mutex<Vec<(String, Document)>>>,
        updated: UpdateLog,
        deleted: Arc<Mutex<Vec<(String, Document)>>>,
        insert_err: Arc<Mutex<Option<CoreError>>>,
        update_err: Arc<Mutex<Option<CoreError>>>,
        delete_results: Arc<Mutex<VecDeque<CoreRes<u64>>>>,
    }

    impl MockMongo {
        fn push_find_one(&self, coll: &str, res: CoreRes<Option<Document>>) {
            self.find_one_map
                .lock()
                .unwrap()
                .entry(coll.to_string())
                .or_default()
                .push_back(res);
        }

        fn push_find_many(&self, coll: &str, res: CoreRes<Vec<Document>>) {
            self.find_many_map
                .lock()
                .unwrap()
                .entry(coll.to_string())
                .or_default()
                .push_back(res);
        }

        fn push_aggregate(&self, res: CoreRes<Vec<Document>>) {
            self.aggregate_res.lock().unwrap().push_back(res);
        }

        fn push_delete(&self, res: CoreRes<u64>) {
            self.delete_results.lock().unwrap().push_back(res);
        }
    }

    #[async_trait]
    impl MongoStorePort for MockMongo {
        async fn find_one(
            &self,
            collection: &str,
            _filter: Document,
            _projection: Option<Document>,
        ) -> CoreRes<Option<Document>> {
            let mut map = self.find_one_map.lock().unwrap();
            if let Some(q) = map.get_mut(collection)
                && let Some(item) = q.pop_front()
            {
                return item;
            }
            Ok(None)
        }

        async fn find_many(
            &self,
            collection: &str,
            _filter: Document,
            _options: MongoFindOptions,
        ) -> CoreRes<Vec<Document>> {
            let mut map = self.find_many_map.lock().unwrap();
            if let Some(q) = map.get_mut(collection)
                && let Some(item) = q.pop_front()
            {
                return item;
            }
            Ok(vec![])
        }

        async fn aggregate(
            &self,
            _collection: &str,
            _pipeline: Vec<Document>,
        ) -> CoreRes<Vec<Document>> {
            self.aggregate_res
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(vec![]))
        }

        async fn count_documents(&self, _collection: &str, _filter: Document) -> CoreRes<u64> {
            Ok(0)
        }

        async fn distinct(
            &self,
            _collection: &str,
            _field: &str,
            _filter: Document,
        ) -> CoreRes<Vec<Bson>> {
            Ok(vec![])
        }

        async fn insert_one(&self, collection: &str, doc: Document) -> CoreRes<()> {
            if let Some(err) = self.insert_err.lock().unwrap().take() {
                return Err(err);
            }
            self.inserted
                .lock()
                .unwrap()
                .push((collection.to_string(), doc));
            Ok(())
        }

        async fn update_one(
            &self,
            collection: &str,
            filter: Document,
            update: Document,
            upsert: bool,
        ) -> CoreRes<u64> {
            if let Some(err) = self.update_err.lock().unwrap().take() {
                return Err(err);
            }
            self.updated
                .lock()
                .unwrap()
                .push((collection.to_string(), filter, update, upsert));
            Ok(1)
        }

        async fn delete_one(&self, collection: &str, filter: Document) -> CoreRes<u64> {
            self.deleted
                .lock()
                .unwrap()
                .push((collection.to_string(), filter));
            self.delete_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(1))
        }

        async fn ping(&self) -> CoreRes<bool> {
            Ok(true)
        }
    }

    #[derive(Clone, Default)]
    struct MockSessionVerifier {
        result: Arc<Mutex<Option<CoreRes<Option<VerifiedSession>>>>>,
    }

    #[async_trait]
    impl SessionVerifierPort for MockSessionVerifier {
        async fn verify_token(&self, _token: &str) -> CoreRes<Option<VerifiedSession>> {
            self.result.lock().unwrap().take().unwrap_or(Ok(None))
        }
    }

    #[derive(Clone, Default)]
    struct MockHttp {
        responses: Arc<Mutex<VecDeque<CoreRes<UpstreamHttpResponse>>>>,
        requests: Arc<Mutex<Vec<UpstreamHttpRequest>>>,
    }

    impl MockHttp {
        fn push(&self, res: CoreRes<UpstreamHttpResponse>) {
            self.responses.lock().unwrap().push_back(res);
        }

        fn push_json(&self, status: u16, body: Value) {
            self.push(Ok(UpstreamHttpResponse {
                status,
                body: serde_json::to_vec(&body).unwrap(),
            }));
        }
    }

    #[async_trait]
    impl UpstreamHttpPort for MockHttp {
        async fn send(&self, request: UpstreamHttpRequest) -> CoreRes<UpstreamHttpResponse> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(UpstreamHttpResponse {
                    status: 200,
                    body: b"{}".to_vec(),
                }))
        }
    }

    #[derive(Clone, Default)]
    struct MockEpic {
        user_res: Arc<Mutex<VecDeque<CoreRes<Option<Value>>>>>,
        gql_res: Arc<Mutex<VecDeque<CoreRes<Value>>>>,
    }

    #[async_trait]
    impl EpicStorePort for MockEpic {
        async fn get_user(
            &self,
            _account_id: &str,
        ) -> std::result::Result<Option<Value>, CoreError> {
            self.user_res
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(None))
        }

        async fn graphql(
            &self,
            _query: &str,
            _variables: &Value,
        ) -> std::result::Result<Value, CoreError> {
            self.gql_res
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(json!({})))
        }

        async fn featured_games(&self) -> std::result::Result<Vec<Value>, CoreError> {
            Ok(vec![])
        }
    }

    #[derive(Clone, Default)]
    struct MockDiscord {
        calls: Arc<Mutex<Vec<(String, String)>>>,
        fail: bool,
    }

    #[async_trait]
    impl DiscordPort for MockDiscord {
        async fn request(
            &self,
            method: &str,
            path: &str,
            _body: Option<&Value>,
        ) -> std::result::Result<Value, CoreError> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), path.to_string()));
            if self.fail {
                Err(CoreError::Upstream("discord err".into()))
            } else {
                Ok(json!({}))
            }
        }
    }

    #[derive(Clone, Default)]
    struct MockWebPush {
        deliveries: Arc<Mutex<Vec<Value>>>,
        outcomes: Arc<Mutex<VecDeque<std::result::Result<(), CoreError>>>>,
    }

    #[async_trait]
    impl WebPushPort for MockWebPush {
        async fn send_notification(
            &self,
            subscription: &Value,
            payload: &[u8],
        ) -> std::result::Result<(), CoreError> {
            self.deliveries.lock().unwrap().push(json!({"subscription":{"endpoint":subscription["endpoint"],"keys":subscription["keys"]},"payload":serde_json::from_slice::<Value>(payload).unwrap()}));
            self.outcomes.lock().unwrap().pop_front().unwrap_or(Ok(()))
        }
    }

    struct Harness {
        state: AppState,
        mongo: Arc<MockMongo>,
        session: Arc<MockSessionVerifier>,
        http: Arc<MockHttp>,
        epic: Arc<MockEpic>,
        discord: Arc<MockDiscord>,
        push: Arc<MockWebPush>,
    }

    fn make_harness(config: ApiConfig) -> Harness {
        let mut state = test_app_state(config);
        state.now = fixed_now;
        let mongo = Arc::new(MockMongo::default());
        let session = Arc::new(MockSessionVerifier::default());
        let http = Arc::new(MockHttp::default());
        let epic = Arc::new(MockEpic::default());
        let discord = Arc::new(MockDiscord::default());
        let push = Arc::new(MockWebPush::default());

        state.mongo = mongo.clone();
        state.session_verifier = session.clone();
        state.http = http.clone();
        state.epic = epic.clone();
        state.discord = discord.clone();
        state.web_push = push.clone();

        Harness {
            state,
            mongo,
            session,
            http,
            epic,
            discord,
            push,
        }
    }

    async fn call(
        state: &AppState,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> (StatusCode, Value, axum::http::HeaderMap) {
        let app = legacy::router(state).with_state(state.clone());
        let mut builder = axum::http::Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let body = match body {
            Some(v) => Body::from(serde_json::to_vec(&v).unwrap()),
            None => Body::empty(),
        };
        let resp = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let resp_headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json_val = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()));
        (status, json_val, resp_headers)
    }

    async fn call_raw(
        state: &AppState,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        raw_body: &'static [u8],
    ) -> (StatusCode, Value) {
        let app = legacy::router(state).with_state(state.clone());
        let mut builder = axum::http::Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let resp = app
            .oneshot(builder.body(Body::from(raw_body)).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json_val = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()));
        (status, json_val)
    }

    fn unsigned_jwt(claims: Value) -> String {
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let p = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        format!("{h}.{p}.sig")
    }

    fn sample_session(email: &str) -> VerifiedSession {
        let mut claims = BTreeMap::new();
        claims.insert(
            "epicAccountId".into(),
            json!(email.split_once('@').map(|(id, _)| id)),
        );
        claims.insert("email".into(), json!(email));
        VerifiedSession {
            subject: "uid-1".into(),
            claims,
        }
    }

    pub(in crate::legacy) fn rsa_keypair_pem() -> (String, String, Value) {
        let priv_pem = include_str!("../../../../oracles/account-fixture-rsa-private.pem");
        let pub_pem = include_str!("../../../../oracles/account-fixture-rsa-public.pem");
        let jwk = json!({
            "kty": "RSA",
            "n": "olnvoz7705-dmTAfoMnmBttJW95xoY-qgtk3IzpDzeCG0FdkBXGqIsngbNWQ8F2-MTdGcoJwgagAPI4A5SB4g8vNNqruVe13vzg0moX-SzWRuBWgMxa6TWTiijhA1vq1JrsdMHWCaf5qACN62jLbEw43d6z_9vukzmLOqOI82CQdJpNdCCB3C3cUbp9DiL6cyxHFnobKuNQnXslHaCkelaCXvMkZ2gCAiwK5uyRBhV-YR8WGsKEq7EomT469kFI8t9wVgjzvUD-iTNlmeax1c6Cw6tnM8RcngJkzh6TWEvlTB6t8uUSaxSJbmpyBwmstrQr3xcsh_AoMuroPVw658w",
            "e": "AQAB",
            "kid": "kid-1",
            "alg": "RS256",
            "use": "sig",
        });
        (priv_pem.to_string(), pub_pem.to_string(), jwk)
    }

    #[tokio::test]
    async fn epic_middleware_and_donate_routes() {
        let h = make_harness(ApiConfig {
            admin_account_id: Some("admin-acc".into()),
            ..Default::default()
        });

        // Missing EPIC_AUTH
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Missing EPIC_AUTH header or cookie");

        // Invalid JWT format
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[("authorization", "Bearer bad")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid EPIC_AUTH token");

        // Missing sub/appid
        let jwt_missing = unsigned_jwt(json!({ "sub": "acc-1" }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[("cookie", &format!("EPIC_AUTH={jwt_missing}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid EPIC_AUTH token");

        // tokenInfo http error
        let jwt_ok = unsigned_jwt(json!({ "sub": "acc-1", "appid": "app-1" }));
        h.http.push(Err(CoreError::Upstream("net".into())));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[("authorization", &format!("Bearer {jwt_ok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid EPIC_AUTH token");

        // tokenInfo non-200
        h.http.push_json(400, json!({ "error": "invalid" }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[("authorization", &format!("Bearer {jwt_ok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Failed to verify EPIC_AUTH token");

        // tokenInfo inactive
        h.http
            .push_json(200, json!({ "account_id": "acc-1", "active": false }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[("authorization", &format!("Bearer {jwt_ok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Failed to verify EPIC_AUTH token");

        // Valid EPIC_AUTH but missing BetterAuth session -> donate requires session
        h.http
            .push_json(200, json!({ "account_id": "acc-1", "active": true }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[("authorization", &format!("Bearer {jwt_ok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Missing session");

        // Session present + invalid code length
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("acc1@epic.com"))));
        let (st, body, _) = call(&h.state, "POST", "/donate/key/short", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid code");

        // Code already used
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("acc1@epic.com"))));
        h.mongo.push_find_one(
            "key-codes",
            Ok(Some(doc! { "code": "12345678901234567890" })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Code already used");

        // Epic fulfillment error
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("acc1@epic.com"))));
        h.mongo.push_find_one("key-codes", Ok(None));
        h.mongo
            .push_find_one("launcher", Ok(Some(doc! { "access_token": "tok" })));
        h.http.push_json(400, json!({ "error": "bad" }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Failed to verify code");

        // Happy path + Discord role
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("acc1@epic.com"))));
        h.mongo.push_find_one("key-codes", Ok(None));
        h.mongo
            .push_find_one("launcher", Ok(Some(doc! { "access_token": "tok" })));
        h.http.push_json(
            200,
            json!({
                "offerId": "offer-1",
                "accountId": "admin-acc",
                "identityId": "ident-1",
                "details": [{ "entitlementId": "e1", "itemId": "i1", "namespace": "ns1", "country": "US", "entitlementName": "Game" }]
            }),
        );
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "acc1", "discordId": "disc-1" })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/donate/key/12345678901234567890",
            &[],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "ok", "id": "offer-1" }));
        assert_eq!(h.discord.calls.lock().unwrap().len(), 1);

        // GET /donate/key/:code not found & found
        h.mongo.push_find_one("key-codes", Ok(None));
        let (st, body, _) = call(&h.state, "GET", "/donate/key/missing", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Code not found");

        h.mongo.push_find_one(
            "key-codes",
            Ok(Some(doc! { "code": "c1", "details": [{ "itemId": "i1" }] })),
        );
        let (st, body, _) = call(&h.state, "GET", "/donate/key/c1", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!([{ "itemId": "i1" }]));
    }

    #[tokio::test]
    async fn ownership_and_reviews_routes() {
        let mut h = make_harness(ApiConfig::default());
        h.discord = Arc::new(MockDiscord {
            fail: true,
            ..Default::default()
        });
        h.state.discord = h.discord.clone();

        // Ownership: missing product
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("offers", Ok(None));
        let (st, body, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], "Product not found");

        // Ownership: offer missing namespace / sandbox missing / product missing
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1" })));
        let (st, _, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one("sandboxes", Ok(None));
        let (st, _, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo
            .push_find_one("sandboxes", Ok(Some(doc! { "_id": "ns1" })));
        let (st, _, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        // Ownership: epic user missing -> false
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(doc! { "_id": "ns1", "parent": "prod-1" })),
        );
        h.mongo
            .push_find_one("products", Ok(Some(doc! { "_id": "prod-1" })));
        h.epic.user_res.lock().unwrap().push_back(Ok(None));
        let (st, body, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "isOwned": false }));

        // Ownership: graphql ServiceError -> false
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(doc! { "_id": "ns1", "parent": "prod-1" })),
        );
        h.mongo
            .push_find_one("products", Ok(Some(doc! { "_id": "prod-1" })));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({ "epicAccountId": "u1" }))));
        h.epic.gql_res.lock().unwrap().push_back(Ok(json!({
            "data": { "PlayerProfile": { "playerProfile": { "productAchievements": { "__typename": "ServiceError" } } } }
        })));
        let (st, body, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "isOwned": false }));

        // Ownership: empty playerAchievements -> false
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(doc! { "_id": "ns1", "parent": "prod-1" })),
        );
        h.mongo
            .push_find_one("products", Ok(Some(doc! { "_id": "prod-1" })));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({ "epicAccountId": "u1" }))));
        h.epic.gql_res.lock().unwrap().push_back(Ok(json!({
            "PlayerProfile": { "playerProfile": { "productAchievements": { "__typename": "Success", "data": { "playerAchievements": [] } } } }
        })));
        let (st, body, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "isOwned": false }));

        // Ownership: owned -> true (with empty email edge case covered too)
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(
                doc! { "_id": "ns1", "parent": bson::oid::ObjectId::new() },
            )),
        );
        h.mongo.push_find_one(
            "products",
            Ok(Some(doc! { "_id": bson::oid::ObjectId::new() })),
        );
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({ "epicAccountId": "u1" }))));
        h.epic.gql_res.lock().unwrap().push_back(Ok(json!({
            "data": { "PlayerProfile": { "playerProfile": { "productAchievements": { "data": { "playerAchievements": [{}] } } } } }
        })));
        let (st, body, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "isOwned": true }));

        // A verified email alone does not identify the linked Epic account.
        let mut unlinked = sample_session("u1@epic.com");
        unlinked.claims.remove("epicAccountId");
        *h.session.result.lock().unwrap() = Some(Ok(Some(unlinked)));
        let (status, _, _) = call(&h.state, "GET", "/offers/o1/ownership", &[], None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // Reviews POST: missing fields
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/offers/o1/reviews",
            &[],
            Some(json!({ "rating": 0 })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], "Missing required fields");

        // Reviews POST: already reviewed
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("reviews", Ok(Some(doc! { "id": "o1" })));
        let valid_review = json!({ "rating": 5, "title": "Great", "content": { "text": "fun" }, "tags": ["a","b","c","d","e","f"], "recommended": true });
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], "User already reviewed this product");

        // Reviews POST: product not released (missing offer or future releaseDate)
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("reviews", Ok(None));
        h.mongo.push_find_one("offers", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], "Product not released");

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        let future = bson::DateTime::from_chrono(fixed_now() + chrono::Duration::days(5));
        h.mongo.push_find_one("reviews", Ok(None));
        h.mongo.push_find_one(
            "offers",
            Ok(Some(doc! { "id": "o1", "releaseDate": future })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], "Product not released");

        // Reviews POST: product not found
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("reviews", Ok(None));
        h.mongo.push_find_one(
            "offers",
            Ok(Some(
                doc! { "id": "o1", "effectiveDate": "2020-01-01T00:00:00Z" },
            )),
        );
        h.mongo.push_find_one("offers", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], "Product not found");

        // Reviews POST: created 201
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("reviews", Ok(None));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1" })));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(doc! { "_id": "ns1", "parent": "prod-1" })),
        );
        h.mongo
            .push_find_one("products", Ok(Some(doc! { "_id": "prod-1" })));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Err(CoreError::Upstream("down".into())));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::CREATED);
        assert_eq!(body, json!({ "status": "ok" }));

        // Reviews PATCH: missing fields, missing product, missing review, ok
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        let (st, _, _) = call(
            &h.state,
            "PATCH",
            "/offers/o1/reviews",
            &[],
            Some(json!({ "rating": false })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("offers", Ok(None));
        let (st, _, _) = call(
            &h.state,
            "PATCH",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(doc! { "_id": "ns1", "parent": "prod-1" })),
        );
        h.mongo
            .push_find_one("products", Ok(Some(doc! { "_id": "prod-1" })));
        h.mongo.push_find_one("reviews", Ok(None));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({}))));
        h.epic
            .gql_res
            .lock()
            .unwrap()
            .push_back(Err(CoreError::Upstream("err".into())));
        let (st, body, _) = call(
            &h.state,
            "PATCH",
            "/offers/o1/reviews",
            &[],
            Some(valid_review.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], "Review not found");

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1", "namespace": "ns1" })));
        h.mongo.push_find_one(
            "sandboxes",
            Ok(Some(doc! { "_id": "ns1", "parent": "prod-1" })),
        );
        h.mongo
            .push_find_one("products", Ok(Some(doc! { "_id": "prod-1" })));
        h.mongo.push_find_one(
            "reviews",
            Ok(Some(doc! {
                "id": "o1",
                "userId": "u1",
                "rating": 4,
                "title": "Old",
                "content": "Old body",
                "tags": ["x"],
                "recommended": false,
                "updatedAt": bson::DateTime::from_chrono(fixed_now()),
                "editions": []
            })),
        );
        h.epic.user_res.lock().unwrap().push_back(Ok(None));
        let (st, body, _) = call(
            &h.state,
            "PATCH",
            "/offers/o1/reviews",
            &[],
            Some(valid_review),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "status": "ok" }));

        // Reviews DELETE: not found & ok
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("reviews", Ok(None));
        let (st, body, _) = call(&h.state, "DELETE", "/offers/o1/reviews", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], "Review not found");

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("reviews", Ok(Some(doc! { "id": "o1" })));
        let (st, body, _) = call(&h.state, "DELETE", "/offers/o1/reviews", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "status": "ok" }));

        // Reviews permissions: true / false
        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo.push_find_one("reviews", Ok(None));
        let (st, body, _) =
            call(&h.state, "GET", "/offers/o1/reviews/permissions", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "canReview": true }));

        *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("u1@epic.com"))));
        h.mongo
            .push_find_one("reviews", Ok(Some(doc! { "id": "o1" })));
        let (st, body, _) =
            call(&h.state, "GET", "/offers/o1/reviews/permissions", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "canReview": false }));
    }

    #[tokio::test]
    async fn accounts_route_coverage() {
        let h = make_harness(ApiConfig {
            jwt_secret: "jwt-sec".into(),
            cookie_secret: "0123456789abcdef0123456789abcdef".into(),
            ..Default::default()
        });

        // Missing/non-bearer/invalid JWT
        let (st, body, _) = call(&h.state, "GET", "/accounts", &[], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");

        let (st, _, _) = call(
            &h.state,
            "GET",
            "/accounts",
            &[("authorization", "Basic x")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        let (st, _, _) = call(
            &h.state,
            "GET",
            "/accounts",
            &[("authorization", "Bearer bad.jwt")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        let enc_id = encrypt_with_iv(
            "google-doc-1",
            b"0123456789abcdef0123456789abcdef",
            &[1u8; 16],
        )
        .unwrap();
        let jwt_tok = encode(
            &Header::new(Algorithm::HS256),
            &json!({ "id": enc_id }),
            &EncodingKey::from_secret(b"jwt-sec"),
        )
        .unwrap();

        // Missing googleauths doc -> 403
        h.mongo.push_find_one("googleauths", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/accounts",
            &[("authorization", &format!("Bearer {jwt_tok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "User not found");

        // Google API non-200
        h.mongo.push_find_one(
            "googleauths",
            Ok(Some(
                doc! { "_id": "google-doc-1", "access_token": "g-tok" },
            )),
        );
        h.http.push_json(401, json!({ "error": "expired" }));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/accounts",
            &[("authorization", &format!("Bearer {jwt_tok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Failed to get account info");
        assert_eq!(body["details"], json!({ "error": "expired" }));

        // Google API 200
        h.mongo.push_find_one(
            "googleauths",
            Ok(Some(
                doc! { "_id": "google-doc-1", "access_token": "g-tok" },
            )),
        );
        h.http
            .push_json(200, json!({ "sub": "g1", "email": "a@b.com" }));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/accounts",
            &[("authorization", &format!("Bearer {jwt_tok}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "data": { "sub": "g1", "email": "a@b.com" } }));
    }

    #[tokio::test]
    async fn users_routes_coverage() {
        let (priv_pem, _pub_pem, jwk) = rsa_keypair_pem();
        let h = make_harness(ApiConfig {
            google_jwks_url: Some("https://mock.jwks/certs".into()),
            google_client_id: Some("google-client-1".into()),
            ..Default::default()
        });

        // GET /users
        let (st, body, _) = call(&h.state, "GET", "/users", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Hello, World!" }));

        // POST /users/find-or-create missing header
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Authorization header is required");

        // Invalid token (bad header / jwks fail / bad kid / bad iss / bad aud)
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", "Bearer bad")],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid token");

        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("kid-1".into());
        let enc_key = EncodingKey::from_rsa_pem(priv_pem.as_bytes()).unwrap();

        // JWKS non-200
        let g_tok = encode(
            &header,
            &json!({ "exp": Utc::now().timestamp()+3600, "sub": "u1", "email": "u1@test.com", "iss": "accounts.google.com", "aud": "google-client-1" }),
            &enc_key,
        )
        .unwrap();
        h.http.push_json(500, json!({}));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {g_tok}"))],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid token");

        // Bad issuer
        let bad_iss = encode(
            &header,
            &json!({ "exp": Utc::now().timestamp()+3600, "sub": "u1", "email": "u1@test.com", "iss": "evil.com", "aud": "google-client-1" }),
            &enc_key,
        )
        .unwrap();
        h.http.push_json(200, json!({ "keys": [jwk.clone()] }));
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {bad_iss}"))],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Bad audience
        let bad_aud = encode(
            &header,
            &json!({ "exp": Utc::now().timestamp()+3600, "sub": "u1", "email": "u1@test.com", "iss": "https://accounts.google.com", "aud": "other" }),
            &enc_key,
        )
        .unwrap();
        h.http.push_json(200, json!({ "keys": [jwk.clone()] }));
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {bad_aud}"))],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Email mismatch & ID mismatch
        h.http.push_json(200, json!({ "keys": [jwk.clone()] }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {g_tok}"))],
            Some(json!({ "id": "u1", "email": "other@test.com" })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Email does not match");

        h.http.push_json(200, json!({ "keys": [jwk.clone()] }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {g_tok}"))],
            Some(json!({ "id": "wrong", "email": "u1@test.com" })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "ID does not match");

        // Missing body id
        h.http.push_json(200, json!({ "keys": [jwk.clone()] }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {g_tok}"))],
            Some(json!({ "email": "u1@test.com" })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "ID does not match");

        // Existing user & new user
        h.http.push_json(200, json!({ "keys": [jwk.clone()] }));
        h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
        h.mongo.push_find_one(
            "users",
            Ok(Some(doc! { "id": "u1", "email": "u1@test.com" })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {g_tok}"))],
            Some(json!({ "id": "u1", "email": "u1@test.com" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["id"], "u1");

        h.http.push_json(200, json!({ "keys": [jwk] }));
        h.mongo.push_find_one("users", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/find-or-create",
            &[("authorization", &format!("Bearer {g_tok}"))],
            Some(json!({ "id": "u1", "email": "u1@test.com", "displayName": "U1" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["displayName"], "U1");

        // GET /users/discord
        let (st, _, _) = call(&h.state, "GET", "/users/discord", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(500, json!({}));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "Failed to fetch user information from Discord"
        );

        h.http.push_json(200, json!({}));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "User information not found from Discord");

        h.http.push_json(200, json!({ "user": {} }));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "User not found");

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "User not found");

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
        h.mongo
            .push_find_one("users", Ok(Some(doc! { "id": "d-1" })));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["id"], "d-1");

        // POST /users/discord
        let (st, _, _) = call(&h.state, "POST", "/users/discord", &[], Some(json!({}))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(500, json!({}));
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            Some(json!({ "id": "d-1" })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(200, json!({}));
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            Some(json!({ "id": "d-1" })),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            Some(json!({ "id": "other" })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "ID does not match");

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
        h.mongo
            .push_find_one("users", Ok(Some(doc! { "id": "d-1" })));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            Some(json!({ "id": "d-1" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["id"], "d-1");

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users/discord",
            &[("authorization", "Bearer d1")],
            Some(json!({ "id": "d-1", "displayName": "D1" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["displayName"], "D1");

        // PUT /users/epic
        let (st, _, _) = call(&h.state, "PUT", "/users/epic?id=e1", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _, _) = call(
            &h.state,
            "PUT",
            "/users/epic",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push(Err(CoreError::Upstream("err".into())));
        let (st, _, _) = call(
            &h.state,
            "PUT",
            "/users/epic?id=e1",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(200, json!({}));
        let (st, _, _) = call(
            &h.state,
            "PUT",
            "/users/epic?id=e1",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(None));
        let (st, _, _) = call(
            &h.state,
            "PUT",
            "/users/epic?id=e1",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo
            .push_find_one("users", Ok(Some(doc! { "id": "d-1" })));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Err(CoreError::Upstream("e".into())));
        let (st, _, _) = call(
            &h.state,
            "PUT",
            "/users/epic?id=e1",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo
            .push_find_one("users", Ok(Some(doc! { "id": "d-1" })));
        h.epic.user_res.lock().unwrap().push_back(Ok(None));
        let (st, _, _) = call(
            &h.state,
            "PUT",
            "/users/epic?id=e1",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
        h.mongo
            .push_find_one("users", Ok(Some(doc! { "id": "d-1" })));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({ "epicAccountId": "epic-1" }))));
        let (st, body, _) = call(
            &h.state,
            "PUT",
            "/users/epic?id=e1",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "success": true }));

        // DELETE /users/epic
        let (st, _, _) = call(&h.state, "DELETE", "/users/epic", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(500, json!({}));
        let (st, _, _) = call(
            &h.state,
            "DELETE",
            "/users/epic",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http.push_json(200, json!({}));
        let (st, _, _) = call(
            &h.state,
            "DELETE",
            "/users/epic",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(None));
        let (st, _, _) = call(
            &h.state,
            "DELETE",
            "/users/epic",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        h.http.push_json(200, json!({ "user": { "id": "d-1" } }));
        h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
        h.mongo
            .push_find_one("users", Ok(Some(doc! { "id": "d-1" })));
        let (st, body, _) = call(
            &h.state,
            "DELETE",
            "/users/epic",
            &[("authorization", "Bearer d1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "success": true }));

        // GET /users/check-epic
        let (st, _, _) = call(&h.state, "GET", "/users/check-epic", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.mongo
            .push_find_one("users", Ok(Some(doc! { "epicId": "e1" })));
        let (st, body, _) = call(&h.state, "GET", "/users/check-epic?id=e1", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Epic account already associated");

        h.mongo.push_find_one("users", Ok(None));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({ "epicAccountId": "e1" }))));
        let (st, body, _) = call(&h.state, "GET", "/users/check-epic?id=e1", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["profile"]["epicAccountId"], "e1");

        h.mongo.push_find_one("users", Ok(None));
        h.epic.user_res.lock().unwrap().push_back(Ok(None));
        let (st, body, _) = call(&h.state, "GET", "/users/check-epic?id=e1", &[], None).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], "Epic account does not exist");

        h.mongo.push_find_one("users", Ok(None));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Err(CoreError::Upstream("err".into())));
        let (st, body, _) = call(&h.state, "GET", "/users/check-epic?id=e1", &[], None).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Failed to check Epic account");
    }

    #[tokio::test]
    async fn users_service_routes_coverage() {
        let h = make_harness(ApiConfig::default());

        let (st, body, _) = call(&h.state, "GET", "/users-service", &[], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");

        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", "Basic x")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid authorization header");

        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", "Bearer bad")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid JWT");

        let no_sub = unsigned_jwt(json!({ "iss": "epic" }));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", &format!("Bearer eg1~{no_sub}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid JWT");

        let expired = unsigned_jwt(json!({ "sub": "u1", "exp": 1000 }));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", &format!("Bearer eg1~{expired}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "JWT is expired");

        let valid = unsigned_jwt(json!({ "sub": "u1", "exp": fixed_now().timestamp() + 3600 }));
        let auth_hdr = format!("Bearer eg1~{valid}");
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", &auth_hdr)],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        h.http
            .push_json(200, json!({"active":true,"account_id":"different"}));
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", &auth_hdr)],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        h.http
            .push_json(200, json!({"active":true,"account_id":"u1"}));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/users-service",
            &[("authorization", &auth_hdr)],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Hello, World!" }));

        // Playtime
        h.http
            .push_json(200, json!({"active":true,"account_id":"u1"}));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users-service/playtime",
            &[("authorization", &auth_hdr)],
            Some(json!([
                { "accountId": "u1", "artifactId": "art-1", "totalTime": 120 },
                { "accountId": "other", "artifactId": "art-2", "totalTime": 10 },
                { "accountId": "u1", "totalTime": 5 },
                { "artifactId": "art-3", "totalTime": 5 }
            ])),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "ok" }));
        assert_eq!(h.mongo.updated.lock().unwrap().len(), 1);

        // Ownership success, error array, transport failure
        h.http
            .push_json(200, json!({"active":true,"account_id":"u1"}));
        h.http.push_json(200, json!({ "data": { "Entitlements": { "cartOffersValidation": { "fullyOwnedOffers": [{ "offerId": "o1" }] } } } }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users-service/ownership",
            &[("authorization", &auth_hdr)],
            Some(json!([{ "id": "o1", "namespace": "ns1" }, { "id": "", "namespace": "ns1" }])),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["fullyOwnedOffers"][0]["offerId"], "o1");

        h.http
            .push_json(200, json!({"active":true,"account_id":"u1"}));
        h.http
            .push_json(500, json!({ "errors": [{ "message": "denied" }] }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users-service/ownership",
            &[("authorization", &auth_hdr)],
            Some(json!([])),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body[0]["message"], "denied");

        h.http
            .push_json(200, json!({"active":true,"account_id":"u1"}));
        h.http.push(Err(CoreError::Upstream("timeout".into())));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users-service/ownership",
            &[("authorization", &auth_hdr)],
            Some(json!([])),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, Value::Null);

        h.http
            .push_json(200, json!({"active":true,"account_id":"u1"}));
        h.http.push(Ok(UpstreamHttpResponse {
            status: 200,
            body: b"not-json".to_vec(),
        }));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/users-service/ownership",
            &[("authorization", &auth_hdr)],
            Some(json!([])),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, Value::Null);
    }

    #[tokio::test]
    async fn push_routes_coverage() {
        let h_no_cfg = make_harness(ApiConfig::default());
        let (st, body, _) = call(&h_no_cfg.state, "GET", "/push/vapid-public-key", &[], None).await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "VAPID public key not configured");

        let (st, body, _) = call(
            &h_no_cfg.state,
            "POST",
            "/push/send",
            &[("x-api-key", "any")],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "Push notifications admin API not configured");

        let h = make_harness(ApiConfig {
            push_admin_api_key: Some("admin-key".into()),
            vapid_public_key: Some("vapid-pub".into()),
            vapid_private_key: Some("vapid-priv".into()),
            ..Default::default()
        });

        let (st, body, _) = call(&h.state, "GET", "/push/vapid-public-key", &[], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "publicKey": "vapid-pub" }));

        // User API key required
        let (st, body, _) = call(&h.state, "GET", "/push/subscribe", &[], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "API key required");

        // POST /push/subscribe invalid body, existing, new
        let (st, body) = call_raw(
            &h.state,
            "POST",
            "/push/subscribe",
            &[("x-api-key", "u1")],
            b"{",
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "Failed to subscribe");

        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/subscribe",
            &[("x-api-key", "u1")],
            Some(json!({ "endpoint": "https://push", "keys": { "p256dh": "k1" } })),
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        h.mongo
            .push_find_one("pushsubscriptions", Ok(Some(doc! { "id": "sub-existing" })));
        let sub_payload =
            json!({ "endpoint": "https://push", "keys": { "p256dh": "p1", "auth": "a1" } });
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/subscribe",
            &[("x-api-key", "u1")],
            Some(sub_payload.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["id"], "sub-existing");
        assert_eq!(body["message"], "Subscription already exists");

        h.mongo.push_find_one("pushsubscriptions", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/subscribe",
            &[("x-api-key", "u1")],
            Some(sub_payload),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body["message"],
            "Successfully subscribed to push notifications"
        );
        assert!(body["id"].as_str().is_some());

        // GET /push/subscribe
        h.mongo.push_find_many(
            "pushsubscriptions",
            Ok(vec![doc! { "id": "s1", "topics": ["t1"] }]),
        );
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/push/subscribe",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["isSubscribed"], true);
        assert_eq!(body["subscriptionCount"], 1);

        h.mongo
            .push_find_many("pushsubscriptions", Err(CoreError::Internal("db".into())));
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/push/subscribe",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        // DELETE /push/unsubscribe/:id
        h.mongo.push_delete(Ok(0));
        let (st, _, _) = call(
            &h.state,
            "DELETE",
            "/push/unsubscribe/s1",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.mongo.push_delete(Err(CoreError::Internal("db".into())));
        let (st, _, _) = call(
            &h.state,
            "DELETE",
            "/push/unsubscribe/s1",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        h.mongo.push_delete(Ok(1));
        let (st, body, _) = call(
            &h.state,
            "DELETE",
            "/push/unsubscribe/s1",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["message"], "Successfully unsubscribed");

        // Topics subscribe & unsubscribe
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/topics/subscribe",
            &[("x-api-key", "u1")],
            Some(json!({ "subscriptionId": "s1" })),
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        h.mongo.push_find_one("pushsubscriptions", Ok(None));
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/topics/subscribe",
            &[("x-api-key", "u1")],
            Some(json!({ "subscriptionId": "s1", "topics": ["a"] })),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.mongo.push_find_one(
            "pushsubscriptions",
            Ok(Some(doc! { "id": "s1", "topics": ["a"] })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/topics/subscribe",
            &[("x-api-key", "u1")],
            Some(json!({ "subscriptionId": "s1", "topics": ["a", "b"] })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["topics"], json!(["a", "b"]));

        h.mongo.push_find_one("pushsubscriptions", Ok(None));
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/topics/unsubscribe",
            &[("x-api-key", "u1")],
            Some(json!({ "subscriptionId": "s1", "topics": ["a"] })),
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.mongo.push_find_one(
            "pushsubscriptions",
            Ok(Some(doc! { "id": "s1", "topics": ["a", "b"] })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/topics/unsubscribe",
            &[("x-api-key", "u1")],
            Some(json!({ "subscriptionId": "s1", "topics": ["a"] })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["topics"], json!(["b"]));

        // GET /push/subscriptions & /push/subscriptions/:id
        h.mongo.push_find_many(
            "pushsubscriptions",
            Ok(vec![
                doc! { "id": "s1", "endpoint": "https://e", "topics": [] },
            ]),
        );
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/push/subscriptions",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["subscriptions"][0]["id"], "s1");

        h.mongo
            .push_find_many("pushsubscriptions", Err(CoreError::Internal("db".into())));
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/push/subscriptions",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        h.mongo.push_find_one("pushsubscriptions", Ok(None));
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/push/subscriptions/s1",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        h.mongo
            .push_find_one("pushsubscriptions", Err(CoreError::Internal("db".into())));
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/push/subscriptions/s1",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        h.mongo.push_find_one(
            "pushsubscriptions",
            Ok(Some(doc! { "id": "s1", "topics": [] })),
        );
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/push/subscriptions/s1",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["subscription"]["id"], "s1");

        // Admin auth errors
        let (st, _, _) = call(&h.state, "POST", "/push/send", &[], Some(json!({}))).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/send",
            &[("authorization", "Bearer wrong")],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        // /push/send validation error, no subscribers, wildcard + 410 cleanup + other error
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/send",
            &[("x-api-key", "admin-key")],
            Some(json!({ "topic": "a" })),
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        let notif_payload = json!({
            "topic": "offer:123:price",
            "notification": {
                "title": "Sale",
                "body": "50% off",
                "image": "https://img",
                "icon": "https://ico",
                "badge": "https://badge",
                "actions": [{ "action": { "type": "open", "url": "https://egdata.app" }, "title": "View", "icon": "i" }]
            }
        });
        h.mongo.push_find_many("pushsubscriptions", Ok(vec![]));
        h.mongo.push_find_many("pushsubscriptions", Ok(vec![]));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/send",
            &[("x-api-key", "admin-key")],
            Some(notif_payload.clone()),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["subscriberCount"], 0);

        let sub1 = doc! { "id": "sub1", "endpoint": "https://e1", "keys": { "p256dh": "p1", "auth": "a1" } };
        let sub2 = doc! { "id": "sub2", "endpoint": "https://e2", "keys": { "p256dh": "p2", "auth": "a2" } };
        let sub3 = doc! { "id": "sub3", "endpoint": "https://e3", "keys": { "p256dh": "p3", "auth": "a3" } };
        h.mongo
            .push_find_many("pushsubscriptions", Ok(vec![sub1.clone(), sub2]));
        h.mongo
            .push_find_many("pushsubscriptions", Ok(vec![sub1, sub3]));
        h.push.outcomes.lock().unwrap().push_back(Ok(()));
        h.push
            .outcomes
            .lock()
            .unwrap()
            .push_back(Err(CoreError::NotFound("gone".into())));
        h.push
            .outcomes
            .lock()
            .unwrap()
            .push_back(Err(CoreError::Internal("".into())));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/send",
            &[("authorization", "Bearer admin-key")],
            Some(notif_payload),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["totalSubscribers"], 3);
        assert_eq!(body["successful"], 1);
        assert_eq!(body["failed"], 2);
        assert_eq!(body["removed"], 1);
        assert_eq!(body["results"][2]["error"], "Unknown error");

        // /push/send without VAPID private key
        let h_no_vapid = make_harness(ApiConfig {
            push_admin_api_key: Some("admin-key".into()),
            ..Default::default()
        });
        let (st, body, _) = call(
            &h_no_vapid.state,
            "POST",
            "/push/send",
            &[("x-api-key", "admin-key")],
            Some(json!({ "topic": "news", "notification": { "title": "t", "body": "b" } })),
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "Push notifications not configured");

        // /push/send-to-user
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/send-to-user",
            &[("x-api-key", "admin-key")],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _, _) = call(
            &h.state,
            "POST",
            "/push/send-to-user",
            &[("x-api-key", "admin-key")],
            Some(json!({ "userId": "u1" })),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _, _) = call(
            &h_no_vapid.state,
            "POST",
            "/push/send-to-user",
            &[("x-api-key", "admin-key")],
            Some(json!({ "userId": "u1", "notification": { "title": "t", "body": "b" } })),
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);

        h.mongo.push_find_many("pushsubscriptions", Ok(vec![]));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/send-to-user",
            &[("x-api-key", "admin-key")],
            Some(json!({ "userId": "u1", "notification": { "title": "t", "body": "b" } })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["subscriberCount"], 0);

        h.mongo.push_find_many("pushsubscriptions", Ok(vec![doc! { "id": "sub1", "endpoint": "https://e1", "keys": { "p256dh": "p1", "auth": "a1" } }]));
        h.push.outcomes.lock().unwrap().push_back(Ok(()));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/push/send-to-user",
            &[("x-api-key", "admin-key")],
            Some(json!({ "userId": "u1", "notification": { "title": "t", "body": "b" } })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["totalSubscriptions"], 1);
        assert_eq!(body["successful"], 1);

        // /push/topics/stats
        h.mongo
            .push_aggregate(Ok(vec![doc! { "_id": "news", "count": 4 }]));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/push/topics/stats",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "topics": [{ "topic": "news", "subscriberCount": 4 }] })
        );

        h.mongo
            .push_aggregate(Err(CoreError::Internal("agg".into())));
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/push/topics/stats",
            &[("x-api-key", "u1")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn account_link_routes_report_failed_storage_operations() {
        for (method, path, write, provider) in [
            ("GET", "/users/discord", false, "Discord"),
            ("POST", "/users/discord", false, "Discord"),
            ("POST", "/users/discord", true, "Discord"),
            ("PUT", "/users/epic?id=epic-user", false, "Epic Games"),
            ("PUT", "/users/epic?id=epic-user", true, "Epic Games"),
            ("DELETE", "/users/epic", false, "Epic Games"),
            ("DELETE", "/users/epic", true, "Epic Games"),
        ] {
            let h = make_harness(ApiConfig::default());
            h.http
                .push_json(200, json!({"user": {"id": "discord-user"}}));
            let db_error = || CoreError::Internal("database unavailable".into());
            if !write {
                h.mongo.push_find_one("users", Err(db_error()));
            } else if method == "POST" {
                h.mongo.push_find_one("users", Ok(None));
                *h.mongo.insert_err.lock().unwrap() = Some(db_error());
            } else {
                h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
                h.mongo
                    .push_find_one("users", Ok(Some(doc! {"id":"discord-user"})));
                h.epic
                    .user_res
                    .lock()
                    .unwrap()
                    .push_back(Ok(Some(json!({"epicAccountId":"epic-user"}))));
                *h.mongo.update_err.lock().unwrap() = Some(db_error());
            }
            let body = (method == "POST").then(|| json!({"id": "discord-user"}));
            let (status, response, _) = call(
                &h.state,
                method,
                path,
                &[("authorization", "Bearer fixture-token")],
                body,
            )
            .await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{method} {path} (write={write})"
            );
            assert_eq!(
                response["error"],
                format!("Failed to fetch user information from {provider}")
            );
        }
    }

    #[tokio::test]
    async fn launcher_routes_coverage() {
        let (priv_pem, pub_pem, _) = rsa_keypair_pem();

        // Missing auth
        let h_no_pem = make_harness(ApiConfig::default());
        let (st, body, _) = call(&h_no_pem.state, "GET", "/launcher/sandbox/sb1", &[], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Missing EPIC_AUTH header or cookie");

        // Missing JWT_PUBLIC_KEY
        let (st, body, _) = call(
            &h_no_pem.state,
            "GET",
            "/launcher/sandbox/sb1",
            &[("cookie", "EGDATA_AUTH=tok")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Missing JWT_PUBLIC_KEY env variable");

        let h = make_harness(ApiConfig {
            jwt_public_key_pem: Some(pub_pem),
            admin_account_id: Some("adm".into()),
            ..Default::default()
        });

        let enc_key = EncodingKey::from_rsa_pem(priv_pem.as_bytes()).unwrap();
        let wrong_client = encode(
            &Header::new(Algorithm::RS256),
            &json!({ "client_id": "wrong", "exp": Utc::now().timestamp() + 3600 }),
            &enc_key,
        )
        .unwrap();
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/launcher/sandbox/sb1",
            &[("authorization", &format!("Bearer {wrong_client}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid JWT");

        // Valid scoped token can reach the launcher service.
        let valid = encode(
            &Header::new(Algorithm::RS256),
            &json!({ "client_id": LAUNCHER_CLIENT_ID,"exp":Utc::now().timestamp()+3600 }),
            &enc_key,
        )
        .unwrap();

        h.mongo
            .push_find_one("launcher", Ok(Some(doc! { "access_token": "ltok" })));
        h.http.push_json(200, json!({ "id": "sb1" }));
        let (st, body, resp_hdrs) = call(
            &h.state,
            "GET",
            "/launcher/sandbox/sb1",
            &[("authorization", &format!("Bearer {valid}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "id": "sb1" }));
        assert_eq!(
            resp_hdrs.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );

        let before = h.http.requests.lock().unwrap().len();
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/launcher/sandbox/sb1/items?count=10",
            &[("cookie", "EGDATA_AUTH=not.a.jwt")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid JWT");
        assert_eq!(h.http.requests.lock().unwrap().len(), before);

        h.mongo
            .push_find_one("launcher", Ok(Some(doc! { "access_token": "ltok" })));
        h.http.push_json(200, json!({ "elements": [] }));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/launcher/sandbox/sb1/offers?count=5",
            &[("authorization", &format!("Bearer {valid}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "elements": [] }));
        assert!(
            h.http
                .requests
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .url
                .contains("/namespace/sb1/offers?count=5")
        );

        h.mongo
            .push_find_one("launcher", Ok(Some(doc! { "access_token": "ltok" })));
        h.http.push_json(403, json!({}));
        let (st, body, _) = call(
            &h.state,
            "GET",
            "/launcher/sandbox/sb1/items",
            &[("authorization", &format!("Bearer {valid}"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Failed to fetch sandbox items");
        assert!(launcher_url("..", Some("items"), None).is_err());
    }

    #[tokio::test]
    async fn admin_routes_coverage() {
        let h = make_harness(ApiConfig::default());

        // Missing cookie / invalid split / missing user fields
        let (st, body, _) = call(&h.state, "GET", "/admin", &[], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");

        let (st, _, _) = call(
            &h.state,
            "GET",
            "/admin",
            &[("cookie", "EGDATA_AUTH=single")],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        let bad_user = STANDARD.encode(br#"{"user":{"accountId":"a1"}}"#);
        let (st, _, _) = call(
            &h.state,
            "GET",
            "/admin",
            &[("cookie", &format!("EGDATA_AUTH={bad_user}.sig"))],
            None,
        )
        .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        let good_cookie = format!(
            "EGDATA_AUTH={}.sig",
            STANDARD_NO_PAD.encode(br#"{"user":{"accountId":"a1","accessToken":"at"}}"#)
        );

        // tokenInfo failures & missing epic user
        h.http.push_json(401, json!({}));
        let (st, _, _) = call(&h.state, "GET", "/admin", &[("cookie", &good_cookie)], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": false }));
        let (st, _, _) = call(&h.state, "GET", "/admin", &[("cookie", &good_cookie)], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one("epic", Ok(None));
        let (st, _, _) = call(&h.state, "GET", "/admin", &[("cookie", &good_cookie)], None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // Role matrix: viewer GET ok, POST forbidden (200 Unauthorized); editor PATCH ok, POST forbidden; unknown role
        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "viewer" })),
        );
        let (st, body, _) =
            call(&h.state, "GET", "/admin", &[("cookie", &good_cookie)], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "role": "viewer" }));

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "viewer" })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Unauthorized" }));

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "unknown" })),
        );
        let (st, body, _) =
            call(&h.state, "GET", "/admin", &[("cookie", &good_cookie)], None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Unauthorized" }));

        // POST /admin/offers as admin: missing id, already exists, created
        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "admin" })),
        );
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Missing id");

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "admin" })),
        );
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1" })));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({ "id": "o1" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Offer already exists" }));

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "admin" })),
        );
        h.mongo.push_find_one("offers", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "POST",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({ "id": "o1", "title": "Game" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Offer created" }));

        // PATCH /admin/offers as editor: forbidden on POST? tested above; PATCH missing id, not found, updated
        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "editor" })),
        );
        let (st, _, _) = call(
            &h.state,
            "PATCH",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "editor" })),
        );
        h.mongo.push_find_one("offers", Ok(None));
        let (st, body, _) = call(
            &h.state,
            "PATCH",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({ "id": "o1" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Offer not found" }));

        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "editor" })),
        );
        h.mongo
            .push_find_one("offers", Ok(Some(doc! { "id": "o1" })));
        let (st, body, _) = call(
            &h.state,
            "PATCH",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({ "id": "o1", "title": "Updated" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Offer updated" }));

        // Also cover viewer blocked on PATCH /admin/offers
        h.http
            .push_json(200, json!({ "account_id": "a1", "active": true }));
        h.mongo.push_find_one(
            "epic",
            Ok(Some(doc! { "accountId": "a1", "role": "viewer" })),
        );
        let (st, body, _) = call(
            &h.state,
            "PATCH",
            "/admin/offers",
            &[("cookie", &good_cookie)],
            Some(json!({ "id": "o1" })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, json!({ "message": "Unauthorized" }));
    }
}
