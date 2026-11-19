//! Legacy `/auth/*` routes and `epic` / `epic_info` middleware (`src/routes/auth.ts`).

use super::{Routes, common::*, system::query};
use crate::state::AppState;
use egdata_http_core::middleware::origin_auth::sha256_secure_eq;
use axum::{
    body::Body,
    extract::{FromRequest, Multipart, Request, State},
    handler::Handler,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::Response,
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
};
use bson::{Bson, Document, doc, oid::ObjectId};
use chrono::{DateTime, Duration, Utc};
use egdata_core::{
    error::CoreError,
    ports::{
        UpstreamHttpMultipartFile, UpstreamHttpRequest, UpstreamHttpResponse, VerifiedSession,
    },
};
use egdata_infra::{
    auth_pg::parse_cookies,
    bson_json::{bson_doc_to_js_json, bson_to_js_json},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tracing::{error, warn};
use url::Url;
use uuid::Uuid;

const AUTH_ALLOWED_ORIGINS: &[&str] = &[
    "https://egdata.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:4000",
    "https://user-reviews-pr.egdata.app/",
    "https://egdata-370475041422.us-central1.run.app",
    "https://store.epicgames.com",
];

const EPIC_JWKS_URL: &str = "https://api.epicgames.dev/epic/oauth/v2/.well-known/jwks.json";
const EPIC_TOKEN_INFO_URL: &str = "https://api.epicgames.dev/epic/oauth/v2/tokenInfo";
const EPIC_TOKEN_URL: &str = "https://api.epicgames.dev/epic/oauth/v2/token";
const EPIC_ACCOUNTS_URL: &str = "https://api.epicgames.dev/epic/id/v2/accounts";
const LAUNCHER_TOKEN_URL: &str =
    "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token";
const LAUNCHER_CLIENT: &str = "34a02cf8f4414e29b15921876da36f9a";
const LAUNCHER_SECRET: &str = "daafbccc737745039dffe53d94fc76cf";
const DEFAULT_CF_ACCOUNT_ID: &str = "7da0b3179a5b5ef4f1a2d1189f072d0b";
const DEFAULT_DISCORD_CLIENT_ID: &str = "1270522540992888832";
const DEFAULT_DISCORD_REDIRECT_URI: &str = "https://api-gcp.egdata.app/auth/discord/callback";
const DISCORD_DONOR_GUILD_ID: &str = "561598657879605269";
const DISCORD_DONOR_ROLE_ID: &str = "1379892703793512599";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct EpicTokenInfo {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub application_id: String,
    #[serde(default)]
    pub access_token: String,
}

#[derive(Debug, Clone)]
pub(super) struct EpicAuthContext {
    pub epic: Option<EpicTokenInfo>,
    pub session: Option<VerifiedSession>,
}

impl EpicAuthContext {
    fn session_account_id(&self) -> Option<&str> {
        self.session
            .as_ref()
            .and_then(|s| s.claims.get("epicAccountId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
    }

    pub(super) fn account_id(&self) -> Option<&str> {
        self.session_account_id().or_else(|| {
            self.epic
                .as_ref()
                .map(|e| e.account_id.as_str())
                .filter(|id| !id.is_empty())
        })
    }
}

#[derive(Debug, Deserialize)]
struct EpicOAuthTokenResponse {
    access_token: String,
    refresh_token: String,
    expires_at: String,
    refresh_expires_at: String,
}

#[derive(Debug, Deserialize)]
struct EgdataV2JwtClaims {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_at: String,
    #[serde(default)]
    refresh_expires_at: String,
    #[serde(default)]
    jti: String,
}

#[derive(Debug, Deserialize)]
struct PersistBody {
    #[serde(rename = "refreshToken", default)]
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct DiscordTokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct DiscordUserResponse {
    id: String,
}

enum RefreshFailure {
    InvalidGrant,
    Retry,
}

pub(super) fn routes() -> Routes {
    let cors = middleware::from_fn(auth_cors);
    Routes::new("/auth")
        .get("", get_account.layer(cors.clone()))
        .post("/avatar", upload_avatar.layer(cors.clone()))
        .post("/persist", persist.layer(cors.clone()))
        .get("/refresh", get_refresh.layer(cors.clone()))
        .patch("/refresh", patch_refresh.layer(cors.clone()))
        .patch("/refresh-admin", patch_refresh_admin.layer(cors.clone()))
        .post("/v2/persist", v2_persist.layer(cors.clone()))
        .get("/v2/refresh", v2_refresh.layer(cors.clone()))
        .get("/logout", logout.layer(cors.clone()))
        .post("/v2/validate-state", validate_state.layer(cors.clone()))
        .post("/v2/save-state", save_state.layer(cors.clone()))
        .get("/discord/link", discord_link.layer(cors.clone()))
        .get("/discord/callback", discord_callback.layer(cors))
}

fn resolve_auth_cors_origin(origin: Option<&str>) -> &'static str {
    AUTH_ALLOWED_ORIGINS
        .iter()
        .copied()
        .find(|&allowed| Some(allowed) == origin)
        .unwrap_or("https://egdata.app")
}

pub(crate) async fn auth_cors(req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let allow_origin = HeaderValue::from_static(resolve_auth_cors_origin(origin));

    if req.method() == Method::OPTIONS {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        let headers = resp.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,HEAD,PUT,POST,DELETE,PATCH"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type,Authorization"),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("86400"),
        );
        egdata_http_core::middleware::cors::append_vary_token(headers, "Origin");
        egdata_http_core::middleware::cors::append_vary_token(headers, "Access-Control-Request-Headers");
        return resp;
    }

    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    egdata_http_core::middleware::cors::append_vary_token(headers, "Origin");
    resp
}

fn auth_error(status: StatusCode, msg: &str) -> Error {
    Error::Json(status, json!({ "error": msg }))
}

fn redirect(location: &str) -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .body(Body::empty())
        .unwrap()
}

fn basic_auth_header(id: &str, secret: &str) -> String {
    format!("Basic {}", BASE64_STANDARD.encode(format!("{id}:{secret}")))
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let (header, rest) = token.split_once('.')?;
    serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(header.trim_end_matches('=')).ok()?)
        .ok()?
        .as_object()?;
    let (payload_b64, signature) = rest.split_once('.')?;
    if signature.contains('.') {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(payload_b64.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn non_empty_str<'a>(val: &'a Value, key: &str) -> Option<&'a str> {
    val.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn bearer_token_from_headers(headers: &HeaderMap) -> std::result::Result<String, Error> {
    let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Missing authorization header",
        ));
    };
    let token = auth.strip_prefix("Bearer ").unwrap_or(auth);
    if token.is_empty() {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Missing token"));
    }
    Ok(token.to_string())
}

fn extract_epic_auth_token(headers: &HeaderMap) -> Option<String> {
    let from_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let raw = from_header.or_else(|| {
        let cookie_hdr = headers.get(header::COOKIE).and_then(|v| v.to_str().ok())?;
        parse_cookies(cookie_hdr)
            .remove("EPIC_AUTH")
            .filter(|s| !s.is_empty())
    })?;
    Some(raw.strip_prefix("Bearer ").unwrap_or(&raw).to_string())
}

fn form_encoded_body(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        ser.append_pair(k, v);
    }
    ser.finish().into_bytes()
}

async fn post_form(
    state: &AppState,
    url: &str,
    auth_header: Option<&str>,
    pairs: &[(&str, &str)],
) -> std::result::Result<UpstreamHttpResponse, CoreError> {
    let mut headers = BTreeMap::from([(
        "content-type".to_string(),
        "application/x-www-form-urlencoded".to_string(),
    )]);
    if let Some(auth) = auth_header {
        headers.insert("authorization".to_string(), auth.to_string());
    }
    state
        .http
        .send(UpstreamHttpRequest {
            method: "POST".into(),
            url: url.into(),
            headers,
            body: Some(form_encoded_body(pairs)),
            multipart_file: None,
        })
        .await
}

async fn verify_epic_token(
    state: &AppState,
    token: &str,
) -> std::result::Result<EpicTokenInfo, Error> {
    let Some(decoded) = decode_jwt_payload(token) else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Invalid EPIC_AUTH token",
        ));
    };
    if non_empty_str(&decoded, "sub").is_none() || non_empty_str(&decoded, "appid").is_none() {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Invalid EPIC_AUTH token",
        ));
    }

    let resp = post_form(state, EPIC_TOKEN_INFO_URL, None, &[("token", token)])
        .await
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid EPIC_AUTH token"))?;

    if !(200..300).contains(&resp.status) {
        serde_json::from_slice::<serde::de::IgnoredAny>(&resp.body)
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid EPIC_AUTH token"))?;
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to verify EPIC_AUTH token",
        ));
    }

    let mut info: EpicTokenInfo = serde_json::from_slice(&resp.body)
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid EPIC_AUTH token"))?;
    if !info.active || info.account_id.is_empty() {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to verify EPIC_AUTH token",
        ));
    }
    info.access_token = token.to_string();
    Ok(info)
}

/// Resolves either a Better-Auth cookie session or a verified `EPIC_AUTH` JWT (`src/routes/auth.ts:epic`).
pub(super) async fn epic(
    state: &AppState,
    headers: &HeaderMap,
) -> std::result::Result<EpicAuthContext, Error> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if let Ok(Some(session)) = state.session_verifier.verify_epic_session(cookie).await {
        return Ok(EpicAuthContext {
            epic: None,
            session: Some(session),
        });
    }

    let Some(token) = extract_epic_auth_token(headers) else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Missing EPIC_AUTH header or cookie",
        ));
    };
    let info = verify_epic_token(state, &token).await?;
    Ok(EpicAuthContext {
        epic: Some(info),
        session: None,
    })
}

/// Optional `EPIC_AUTH` verification middleware equivalent (`src/routes/auth.ts:epicInfo`).
#[allow(dead_code)]
pub(super) async fn epic_info(state: &AppState, headers: &HeaderMap) -> Option<EpicTokenInfo> {
    let token = extract_epic_auth_token(headers)?;
    verify_epic_token(state, &token).await.ok()
}

async fn get_epic_account(
    state: &AppState,
    access_token: &str,
    account_id: &str,
) -> Result<Option<Value>> {
    let mut url = Url::parse(EPIC_ACCOUNTS_URL).expect("valid Epic accounts URL");
    url.query_pairs_mut().append_pair("accountId", account_id);
    let resp = state
        .http
        .send(UpstreamHttpRequest {
            method: "GET".into(),
            url: url.to_string(),
            headers: BTreeMap::from([(
                "authorization".to_string(),
                format!("Bearer {access_token}"),
            )]),
            body: None,
            multipart_file: None,
        })
        .await?;
    let rows: Value = serde_json::from_slice(&resp.body).map_err(|_| Error::Internal)?;
    match rows {
        Value::Null => Err(Error::Internal),
        Value::Array(rows) => Ok(rows.into_iter().next().filter(|v| !v.is_null())),
        Value::Object(mut rows) => Ok(rows.remove("0").filter(|v| !v.is_null())),
        _ => Ok(None),
    }
}

fn parse_iso_datetime(raw: &str) -> Option<bson::DateTime> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| bson::DateTime::from_chrono(dt.with_timezone(&Utc)))
}

fn parse_bson_datetime(val: &Bson) -> Option<DateTime<Utc>> {
    match val {
        Bson::DateTime(dt) => Some(dt.to_chrono()),
        Bson::String(s) => DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc)),
        _ => None,
    }
}

fn format_token_response(doc: &Document) -> Value {
    let mut response = json!({});
    for key in [
        "accessToken",
        "refreshToken",
        "expiresAt",
        "refreshExpiresAt",
    ] {
        if let Some(value) = doc.get(key) {
            response[key] = bson_to_js_json(value);
        }
    }
    response
}

async fn refresh_epic_oauth_token(
    state: &AppState,
    refresh_token: &str,
) -> std::result::Result<EpicOAuthTokenResponse, RefreshFailure> {
    let client_id = state
        .config
        .epic_client_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or(RefreshFailure::Retry)?;
    let client_secret = state
        .config
        .epic_client_secret
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or(RefreshFailure::Retry)?;
    let auth = basic_auth_header(client_id, client_secret);
    let resp = post_form(
        state,
        EPIC_TOKEN_URL,
        Some(&auth),
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", "basic_profile"),
        ],
    )
    .await
    .map_err(|_| RefreshFailure::Retry)?;

    if !(200..300).contains(&resp.status) {
        let body: Value = serde_json::from_slice(&resp.body).unwrap_or_default();
        let invalid = (resp.status == 400 || resp.status == 401)
            && (body["error"] == "invalid_grant"
                || body["errorCode"] == "invalid_grant"
                || body["errorCode"] == "errors.com.epicgames.account.oauth.invalid_refresh_token");
        return Err(if invalid {
            RefreshFailure::InvalidGrant
        } else {
            RefreshFailure::Retry
        });
    }

    serde_json::from_slice::<EpicOAuthTokenResponse>(&resp.body).map_err(|_| RefreshFailure::Retry)
}

pub(super) async fn verify_provider_jwt(
    s: &AppState,
    token: &str,
    jwks_url: &str,
    validation: &Validation,
) -> std::result::Result<Value, ()> {
    let header = decode_header(token).map_err(|_| ())?;
    if !validation.algorithms.contains(&header.alg) {
        return Err(());
    }
    let kid = header.kid.ok_or(())?;
    let resp = s
        .http
        .send(UpstreamHttpRequest {
            method: "GET".into(),
            url: jwks_url.to_string(),
            headers: BTreeMap::new(),
            body: None,
            multipart_file: None,
        })
        .await
        .map_err(|_| ())?;
    if !(200..300).contains(&resp.status) {
        return Err(());
    }

    let certs: Value = serde_json::from_slice(&resp.body).map_err(|_| ())?;
    let key_val = certs
        .get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| {
            keys.iter()
                .find(|k| k.get("kid").and_then(Value::as_str) == Some(kid.as_str()))
        })
        .ok_or(())?
        .clone();

    let jwk: Jwk = serde_json::from_value(key_val).map_err(|_| ())?;
    let decoding_key = DecodingKey::from_jwk(&jwk).map_err(|_| ())?;

    let claims = decode::<Value>(token, &decoding_key, validation)
        .map_err(|_| ())?
        .claims;
    Ok(claims)
}

fn verify_rs256_jwt(
    pem: Option<&str>,
    token: &str,
) -> std::result::Result<EgdataV2JwtClaims, Error> {
    let Some(pem) = pem.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Missing JWT_PUBLIC_KEY env variable",
        ));
    };
    let key = DecodingKey::from_rsa_pem(pem.as_bytes())
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.required_spec_claims.clear();
    validation.leeway = 0;

    let data = decode::<EgdataV2JwtClaims>(token, &key, &validation)
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;
    if data.claims.access_token.is_empty() || data.claims.jti.is_empty() {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"));
    }
    Ok(data.claims)
}

async fn get_account(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let auth = epic(&s, &headers).await?;
    let Some(epic_var) = auth.epic.filter(|e| !e.account_id.is_empty()) else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Missing EPIC_ACCOUNT_ID",
        ));
    };

    if let Some(entry) = s
        .mongo
        .find_one(
            "epic",
            doc! { "accountId": { "$eq": &epic_var.account_id } },
            None,
        )
        .await?
    {
        return Ok(ok(&bson_doc_to_js_json(&entry)));
    }

    warn!("No epic entry found, fetching from Epic Games");
    let Some(profile) = get_epic_account(&s, &epic_var.access_token, &epic_var.account_id).await?
    else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to fetch Epic profile",
        ));
    };

    let mut doc = bson::to_document(&profile).map_err(|_| Error::Internal)?;
    doc.insert("creationDate", bson::DateTime::from_chrono((s.now)()));
    s.mongo.insert_one("epic", doc).await?;
    Ok(ok(&profile))
}

async fn upload_avatar(State(s): State<AppState>, req: Request) -> Result<Response> {
    let auth = epic(&s, req.headers()).await?;
    let account_id = auth
        .account_id()
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Missing EPIC_ACCOUNT_ID"))?
        .to_string();

    let mut multipart = Multipart::from_request(req, &s)
        .await
        .map_err(|_| auth_error(StatusCode::BAD_REQUEST, "Missing file"))?;

    let mut avatar: Option<(String, String, Vec<u8>)> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("avatar") {
            let file_name = field.file_name().unwrap_or("avatar.png").to_string();
            let content_type = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_string();
            let bytes = field
                .bytes()
                .await
                .map_err(|_| auth_error(StatusCode::BAD_REQUEST, "Missing file"))?;
            avatar = Some((file_name, content_type, bytes.to_vec()));
            break;
        }
    }

    let Some((orig_name, content_type, bytes)) = avatar else {
        return Err(auth_error(StatusCode::BAD_REQUEST, "Missing file"));
    };

    let cf_account = s
        .config
        .cloudflare_account_id
        .as_deref()
        .unwrap_or(DEFAULT_CF_ACCOUNT_ID);
    let cf_token = s.config.cloudflare_images_token.as_deref().unwrap_or("");
    let ext = orig_name.rsplit('.').next().unwrap_or("");
    let upload_name = format!("{account_id}.{ext}");

    let resp = s
        .http
        .send(UpstreamHttpRequest {
            method: "POST".into(),
            url: format!("https://api.cloudflare.com/client/v4/accounts/{cf_account}/images/v1"),
            headers: BTreeMap::from([("authorization".to_string(), format!("Bearer {cf_token}"))]),
            body: None,
            multipart_file: Some(UpstreamHttpMultipartFile {
                field_name: "file".into(),
                filename: upload_name,
                content_type,
                bytes,
            }),
        })
        .await?;

    let data: Value = serde_json::from_slice(&resp.body)?;
    if !(200..300).contains(&resp.status) {
        return Err(auth_error(
            StatusCode::BAD_REQUEST,
            "Failed to upload avatar",
        ));
    }

    let result = data.get("result").cloned().unwrap_or(Value::Null);
    let result_bson = bson::to_bson(&result).map_err(|_| Error::Internal)?;

    s.mongo
        .update_one(
            "epic",
            doc! { "accountId": { "$eq": &account_id } },
            doc! { "$set": { "avatarUrl": result_bson } },
            false,
        )
        .await?;

    Ok(ok(&result))
}

async fn persist(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response> {
    let auth = epic(&s, &headers).await?;
    let epic_var = auth
        .epic
        .filter(|e| !e.account_id.is_empty())
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Missing EPIC_ACCOUNT_ID"))?;

    let parsed: PersistBody = serde_json::from_slice(&body)
        .map_err(|_| auth_error(StatusCode::BAD_REQUEST, "Malformed request"))?;
    let decoded = decode_jwt_payload(&parsed.refresh_token)
        .ok_or_else(|| auth_error(StatusCode::BAD_REQUEST, "Malformed request"))?;
    let token_id = non_empty_str(&decoded, "jti")
        .ok_or_else(|| auth_error(StatusCode::BAD_REQUEST, "Malformed request"))?
        .to_string();

    let access_resp = post_form(
        &s,
        EPIC_TOKEN_INFO_URL,
        None,
        &[("token", &epic_var.access_token)],
    )
    .await?;
    let access_info: EpicTokenInfo = serde_json::from_slice(&access_resp.body)?;
    let refresh_resp = post_form(
        &s,
        EPIC_TOKEN_INFO_URL,
        None,
        &[("token", &parsed.refresh_token)],
    )
    .await?;
    let refresh_info: EpicTokenInfo = serde_json::from_slice(&refresh_resp.body)?;

    if !(200..300).contains(&access_resp.status)
        || !(200..300).contains(&refresh_resp.status)
        || !access_info.active
        || !refresh_info.active
        || access_info.account_id.is_empty()
    {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid tokens"));
    }
    if access_info.account_id != refresh_info.account_id
        || access_info.account_id != epic_var.account_id
    {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Tokens are not for the same account",
        ));
    }

    let now = (s.now)();
    let id=s.mongo
        .upsert_one_returning_id(
            "tokens",
            doc! { "tokenId": { "$eq": &token_id } },
            doc! {
                "$set": {
                    "accessToken": &epic_var.access_token,
                    "refreshToken": &parsed.refresh_token,
                    "expiresAt": bson::DateTime::from_chrono(now + Duration::seconds(access_info.expires_in)),
                    "refreshExpiresAt": bson::DateTime::from_chrono(now + Duration::seconds(refresh_info.expires_in)),
                    "accountId": &epic_var.account_id,
                }
            },
        )
        .await?;

    let upserted_id = id.as_ref().map(bson_to_js_json);
    Ok(ok(&json!({ "id": upserted_id, "status": "ok" })))
}

async fn get_refresh(State(s): State<AppState>, headers: HeaderMap, uri: Uri) -> Result<Response> {
    let auth_token = bearer_token_from_headers(&headers)?;
    let decoded = decode_jwt_payload(auth_token.strip_prefix("eg1~").unwrap_or(&auth_token))
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let Some(sub) = non_empty_str(&decoded, "sub").map(str::to_string) else {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    };
    let Some(iss) = non_empty_str(&decoded, "iss") else {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    };
    if !iss.starts_with("https://api.epicgames.dev/epic/") {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    }
    let audience = s
        .config
        .epic_client_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    if decoded["aud"].as_str() != Some(audience) {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    }
    let id = query(&uri, "id")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| auth_error(StatusCode::BAD_REQUEST, "Missing id parameter"))?;
    let oid = ObjectId::parse_str(&id)
        .map_err(|_| auth_error(StatusCode::BAD_REQUEST, "Invalid id parameter"))?;

    let now = (s.now)();
    let expires = decoded["exp"]
        .as_i64()
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Invalid token"))?;
    if expires > now.timestamp() {
        // ID tokens use Epic's public signing keys. OAuth access tokens use Epic's live introspection.
        if iss.starts_with("https://api.epicgames.dev/epic/oauth/") {
            let response = post_form(&s, EPIC_TOKEN_INFO_URL, None, &[("token", &auth_token)])
                .await
                .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid token"))?;
            let info: EpicTokenInfo = serde_json::from_slice(&response.body)
                .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid token"))?;
            if !(200..300).contains(&response.status)
                || !info.active
                || info.account_id != sub
                || info.client_id != audience
            {
                return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
            }
        } else {
            let mut validation = Validation::new(Algorithm::RS256);
            validation.set_audience(&[audience]);
            validation.set_required_spec_claims(&["iss", "sub", "aud", "exp"]);
            // Use the application's injectable clock for time checks.
            validation.validate_exp = false;
            validation.validate_nbf = false;
            let signed = verify_provider_jwt(&s, &auth_token, EPIC_JWKS_URL, &validation)
                .await
                .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid token"))?;
            if signed["iat"]
                .as_i64()
                .is_none_or(|iat| iat > now.timestamp())
                || signed
                    .get("nbf")
                    .is_some_and(|v| v.as_i64().is_none_or(|n| n > now.timestamp()))
            {
                return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
            }
        }
    }
    let mut filter = doc! {"_id":oid,"accountId":{"$eq":&sub}};
    let expired = expires <= now.timestamp();
    if expired {
        // The exact stored access credential can authorize rotation while its refresh token is alive.
        // An expired identity token alone cannot be exchanged for current credentials.
        filter.insert("accessToken", doc! {"$eq":&auth_token});
    }
    let mut token = s
        .mongo
        .find_one("tokens", filter, None)
        .await?
        .ok_or_else(|| {
            if expired {
                auth_error(StatusCode::UNAUTHORIZED, "Invalid token")
            } else {
                auth_error(StatusCode::NOT_FOUND, "Token not found")
            }
        })?;
    if expired
        && token
            .get("refreshExpiresAt")
            .and_then(parse_bson_datetime)
            .is_none_or(|d| d <= now)
    {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    }
    let expires_at = token.get("expiresAt").and_then(parse_bson_datetime);
    if expires_at.is_some_and(|exp| exp < (s.now)()) {
        let refresh_tok = token
            .get_str("refreshToken")
            .unwrap_or_default()
            .to_string();
        let refreshed = refresh_epic_oauth_token(&s, &refresh_tok)
            .await
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Failed to refresh token"))?;
        let new_exp = parse_iso_datetime(&refreshed.expires_at)
            .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Failed to refresh token"))?;
        let new_refresh_exp = parse_iso_datetime(&refreshed.refresh_expires_at)
            .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Failed to refresh token"))?;

        s.mongo
            .update_one(
                "tokens",
                doc! {"_id":oid,"accountId":&sub,"refreshToken":&refresh_tok},
                doc! {
                    "$set": {
                        "accessToken": &refreshed.access_token,
                        "refreshToken": &refreshed.refresh_token,
                        "expiresAt": new_exp,
                        "refreshExpiresAt": new_refresh_exp,
                    }
                },
                false,
            )
            .await?;

        token = s
            .mongo
            .find_one("tokens", doc! {"_id":oid,"accountId":&sub}, None)
            .await?
            .ok_or_else(|| auth_error(StatusCode::NOT_FOUND, "Token not found"))?;
    }

    Ok(super::common::cache_header(
        ok(&format_token_response(&token)),
        "private, no-store",
    ))
}

async fn patch_refresh(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let token = bearer_token_from_headers(&headers)?;
    if s.config.jwt_secret.is_empty() || !sha256_secure_eq(&token, &s.config.jwt_secret) {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    }

    let now = (s.now)();
    let cutoff = now + Duration::minutes(10);
    let tokens = s
        .mongo
        .find_many(
            "tokens",
            doc! { "expiresAt": { "$lt": bson::DateTime::from_chrono(cutoff) } },
            Default::default(),
        )
        .await?;

    for doc in tokens {
        let token_id = doc.get_str("tokenId").unwrap_or_default().to_string();
        let refresh_token = doc.get_str("refreshToken").unwrap_or_default().to_string();
        let refresh_expires_at = doc.get("refreshExpiresAt").and_then(parse_bson_datetime);

        let filter = doc! {"tokenId":&token_id,"refreshToken":&refresh_token};
        if refresh_expires_at.is_some_and(|exp| exp < now) {
            s.mongo.delete_one("tokens", filter).await?;
            continue;
        }
        match refresh_single_token(&s, &token_id, &refresh_token).await {
            Ok(()) => {}
            Err(RefreshFailure::InvalidGrant) => {
                s.mongo.delete_one("tokens", filter).await?;
                let _ = s
                    .telegram
                    .send_message("A stored Epic refresh grant is no longer valid.")
                    .await;
            }
            Err(RefreshFailure::Retry) => {
                let _ = s
                    .telegram
                    .send_message("Epic token refresh failed. The stored grant will be retried.")
                    .await;
            }
        }
    }

    Ok(ok(&json!({ "status": "ok" })))
}

async fn refresh_single_token(
    state: &AppState,
    token_id: &str,
    refresh_token: &str,
) -> std::result::Result<(), RefreshFailure> {
    let refreshed = refresh_epic_oauth_token(state, refresh_token).await?;
    let expires_at = parse_iso_datetime(&refreshed.expires_at).ok_or(RefreshFailure::Retry)?;
    let refresh_expires_at =
        parse_iso_datetime(&refreshed.refresh_expires_at).ok_or(RefreshFailure::Retry)?;

    state
        .mongo
        .update_one(
            "tokens",
            doc! {"tokenId":token_id,"refreshToken":refresh_token},
            doc! {
                "$set": {
                    "accessToken": &refreshed.access_token,
                    "refreshToken": &refreshed.refresh_token,
                    "expiresAt": expires_at,
                    "refreshExpiresAt": refresh_expires_at,
                }
            },
            false,
        )
        .await
        .map_err(|_| RefreshFailure::Retry)?;
    Ok(())
}

async fn patch_refresh_admin(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Missing authorization header",
        ));
    };

    let Some(token) = auth.strip_prefix("Bearer ") else {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Invalid authorization header",
        ));
    };

    if s.config.jwt_secret.is_empty() || !sha256_secure_eq(token, &s.config.jwt_secret) {
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Invalid JWT_SECRET token",
        ));
    }

    let admin_id_bson = s
        .config
        .admin_account_id
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| auth_error(StatusCode::NOT_FOUND, "User not found"))?;
    let user = s
        .mongo
        .find_one("launcher", doc! { "account_id": admin_id_bson }, None)
        .await?
        .ok_or_else(|| auth_error(StatusCode::NOT_FOUND, "User not found"))?;

    let refresh_token = user.get_str("refresh_token").unwrap_or_default();
    let expires_at = user.get("expires_at").and_then(parse_bson_datetime);
    if expires_at.is_some_and(|exp| exp > (s.now)() + Duration::minutes(10)) {
        return Ok(ok(&json!({ "message": "Token is not expired" })));
    }

    let auth_header = basic_auth_header(LAUNCHER_CLIENT, LAUNCHER_SECRET);
    let resp = post_form(
        &s,
        LAUNCHER_TOKEN_URL,
        Some(&auth_header),
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ],
    )
    .await
    .map_err(|_| {
        auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to refresh admin user tokens",
        )
    })?;

    if !(200..300).contains(&resp.status) {
        let _ = s
            .telegram
            .send_message(
                "Failed to refresh admin user tokens, the bot won't be able to get new data from Epic Games.",
            )
            .await;
        return Err(auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to refresh admin user tokens",
        ));
    }

    let data: EpicOAuthTokenResponse = serde_json::from_slice(&resp.body).map_err(|_| {
        auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to refresh admin user tokens",
        )
    })?;
    let new_exp = parse_iso_datetime(&data.expires_at).ok_or_else(|| {
        auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to refresh admin user tokens",
        )
    })?;
    let new_refresh_exp = parse_iso_datetime(&data.refresh_expires_at).ok_or_else(|| {
        auth_error(
            StatusCode::UNAUTHORIZED,
            "Failed to refresh admin user tokens",
        )
    })?;

    s.mongo
        .update_one(
            "launcher",
            doc! {"account_id":admin_id_bson,"refresh_token":refresh_token},
            doc! {
                "$set": {
                    "access_token": &data.access_token,
                    "refresh_token": &data.refresh_token,
                    "expires_at": new_exp,
                    "refresh_expires_at": new_refresh_exp,
                }
            },
            false,
        )
        .await?;

    Ok(ok(&json!({ "status": "ok" })))
}

async fn v2_persist(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let token = bearer_token_from_headers(&headers)?;
    let egdata_jwt = verify_rs256_jwt(s.config.jwt_public_key_pem.as_deref(), &token)?;

    let decoded = decode_jwt_payload(&egdata_jwt.access_token)
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;
    let Some(sub) = non_empty_str(&decoded, "sub").map(str::to_string) else {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"));
    };
    if non_empty_str(&decoded, "iss").is_none() {
        return Err(auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"));
    }

    let expires_at = parse_iso_datetime(&egdata_jwt.expires_at)
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;
    let refresh_expires_at = parse_iso_datetime(&egdata_jwt.refresh_expires_at)
        .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;

    s.mongo
        .update_one(
            "tokens",
            doc! { "tokenId": &egdata_jwt.jti },
            doc! {
                "$set": {
                    "accessToken": &egdata_jwt.access_token,
                    "refreshToken": &egdata_jwt.refresh_token,
                    "expiresAt": expires_at,
                    "refreshExpiresAt": refresh_expires_at,
                    "accountId": &sub,
                }
            },
            true,
        )
        .await
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;

    let existing = s
        .mongo
        .find_one("epic", doc! { "accountId": { "$eq": &sub } }, None)
        .await
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;

    if existing.is_none() {
        let mut set_doc = match get_epic_account(&s, &egdata_jwt.access_token, &sub)
            .await
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?
        {
            Some(user) => bson::to_document(&user).unwrap_or_default(),
            None => Document::new(),
        };
        set_doc.insert("creationDate", bson::DateTime::from_chrono((s.now)()));
        s.mongo
            .update_one(
                "epic",
                doc! { "accountId": &sub },
                doc! { "$set": set_doc },
                true,
            )
            .await
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;
    }

    Ok(ok(&json!({ "id": egdata_jwt.jti, "status": "ok" })))
}

async fn v2_refresh(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let token = bearer_token_from_headers(&headers)?;
    let egdata_jwt = verify_rs256_jwt(s.config.jwt_public_key_pem.as_deref(), &token)?;

    let mut db_token = s
        .mongo
        .find_one(
            "tokens",
            doc! { "tokenId": { "$eq": &egdata_jwt.jti } },
            None,
        )
        .await
        .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?
        .ok_or_else(|| auth_error(StatusCode::NOT_FOUND, "Token not found"))?;

    let expires_at = db_token.get("expiresAt").and_then(parse_bson_datetime);
    if expires_at.is_some_and(|exp| exp < (s.now)()) {
        let refresh_tok = db_token
            .get_str("refreshToken")
            .unwrap_or_default()
            .to_string();
        let refreshed = refresh_epic_oauth_token(&s, &refresh_tok)
            .await
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Failed to refresh token"))?;
        let new_exp = parse_iso_datetime(&refreshed.expires_at)
            .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Failed to refresh token"))?;
        let new_refresh_exp = parse_iso_datetime(&refreshed.refresh_expires_at)
            .ok_or_else(|| auth_error(StatusCode::UNAUTHORIZED, "Failed to refresh token"))?;

        s.mongo
            .update_one(
                "tokens",
                doc! {"tokenId":{"$eq":&egdata_jwt.jti},"refreshToken":&refresh_tok},
                doc! {
                    "$set": {
                        "accessToken": &refreshed.access_token,
                        "refreshToken": &refreshed.refresh_token,
                        "expiresAt": new_exp,
                        "refreshExpiresAt": new_refresh_exp,
                    }
                },
                false,
            )
            .await
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?;

        db_token = s
            .mongo
            .find_one(
                "tokens",
                doc! { "tokenId": { "$eq": &egdata_jwt.jti } },
                None,
            )
            .await
            .map_err(|_| auth_error(StatusCode::UNAUTHORIZED, "Invalid JWT"))?
            .ok_or_else(|| auth_error(StatusCode::NOT_FOUND, "Token not found"))?;
    }

    Ok(super::common::cache_header(
        ok(&format_token_response(&db_token)),
        "private, no-store",
    ))
}

async fn logout() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(
            header::SET_COOKIE,
            "EGDATA_AUTH=; Max-Age=0; Path=/; Domain=egdata.app; HttpOnly; Secure",
        )
        .header(header::LOCATION, "https://egdata.app/")
        .body(Body::empty())
        .unwrap()
}

async fn validate_state(State(s): State<AppState>, body: axum::body::Bytes) -> Result<Response> {
    let value: Value = serde_json::from_slice(&body)?;
    if value.is_null() {
        return Err(Error::Internal);
    }
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| auth_error(StatusCode::BAD_REQUEST, "Missing state parameter"))?;

    let found = s
        .saved_queries
        .get(&format!("state-code:{state}"))
        .await?
        .filter(|v| !v.is_empty());

    if found.is_none() {
        return Err(auth_error(StatusCode::BAD_REQUEST, "Invalid state code"));
    }

    Ok(ok(&json!({ "valid": true })))
}

async fn save_state(State(s): State<AppState>) -> Result<Response> {
    let code = Uuid::new_v4().simple().to_string().to_uppercase();
    s.saved_queries
        .set(&format!("state-code:{code}"), "true", 3600)
        .await?;
    Ok(ok(&json!({ "state": code })))
}

fn discord_state_key(auth: &EpicAuthContext, state: Uuid) -> Option<String> {
    let session = auth.session.as_ref()?;
    let session_id = session
        .claims
        .get("sessionId")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    Some(format!("discord-oauth:{session_id}:{state}"))
}

async fn discord_link(State(s): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let auth = epic(&s, &headers).await?;
    let state = Uuid::new_v4();
    let Some(key) = discord_state_key(&auth, state) else {
        return Ok(redirect("https://egdata.app/"));
    };
    s.saved_queries.set(&key, "1", 600).await?;
    let client_id = s
        .config
        .discord_client_id
        .as_deref()
        .unwrap_or(DEFAULT_DISCORD_CLIENT_ID);
    let redirect_uri = s
        .config
        .discord_redirect_uri
        .as_deref()
        .unwrap_or(DEFAULT_DISCORD_REDIRECT_URI);

    let mut url = Url::parse("https://discord.com/oauth2/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", "identify")
        .append_pair("state", &state.to_string());

    Ok(redirect(url.as_str()))
}

async fn discord_callback(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    let auth = epic(&s, &headers).await?;

    if query(&uri, "error").is_some_and(|e| !e.is_empty()) {
        return Ok(redirect("https://egdata.app/"));
    }

    let Some(account_id) = auth.session_account_id().map(str::to_string) else {
        return Ok(redirect("https://egdata.app/"));
    };

    let Some(code) = query(&uri, "code").filter(|code| !code.is_empty()) else {
        return Ok(redirect("https://egdata.app/"));
    };
    let Some(key) = query(&uri, "state")
        .and_then(|value| Uuid::parse_str(&value).ok())
        .and_then(|state| discord_state_key(&auth, state))
    else {
        return Ok(redirect("https://egdata.app/"));
    };
    if !s.saved_queries.consume(&key).await? {
        return Ok(redirect("https://egdata.app/"));
    }
    let client_id = s
        .config
        .discord_client_id
        .as_deref()
        .unwrap_or(DEFAULT_DISCORD_CLIENT_ID);
    let client_secret = s.config.discord_client_secret.as_deref().unwrap_or("");
    let redirect_uri = s
        .config
        .discord_redirect_uri
        .as_deref()
        .unwrap_or(DEFAULT_DISCORD_REDIRECT_URI);

    let token_resp = match post_form(
        &s,
        "https://discord.com/api/v10/oauth2/token",
        None,
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", redirect_uri),
        ],
    )
    .await
    {
        Ok(resp) if (200..300).contains(&resp.status) => resp,
        _ => {
            return Ok(redirect(
                "https://egdata.app/?error=discord-get-token-failed",
            ));
        }
    };

    let Some(token_data) = serde_json::from_slice::<DiscordTokenResponse>(&token_resp.body)
        .ok()
        .filter(|data| !data.access_token.is_empty())
    else {
        return Ok(redirect(
            "https://egdata.app/?error=discord-get-token-failed",
        ));
    };

    let user_resp = match s
        .http
        .send(UpstreamHttpRequest {
            method: "GET".into(),
            url: "https://discord.com/api/v10/users/@me".into(),
            headers: BTreeMap::from([(
                "authorization".to_string(),
                format!("Bearer {}", token_data.access_token),
            )]),
            body: None,
            multipart_file: None,
        })
        .await
    {
        Ok(resp) if (200..300).contains(&resp.status) => resp,
        _ => {
            return Ok(redirect(
                "https://egdata.app/?error=discord-get-user-failed",
            ));
        }
    };

    let Some(user_data) = serde_json::from_slice::<DiscordUserResponse>(&user_resp.body)
        .ok()
        .filter(|data| !data.id.is_empty())
    else {
        return Ok(redirect(
            "https://egdata.app/?error=discord-get-user-failed",
        ));
    };

    s.mongo
        .update_one(
            "epic",
            doc! { "accountId": { "$eq": &account_id } },
            doc! { "$set": { "discordId": &user_data.id } },
            false,
        )
        .await?;

    let is_donor = s
        .mongo
        .find_one(
            "key-codes",
            doc! { "accountId": { "$eq": &account_id } },
            None,
        )
        .await?
        .is_some();

    if is_donor {
        let role_path = format!(
            "/guilds/{DISCORD_DONOR_GUILD_ID}/members/{}/roles/{DISCORD_DONOR_ROLE_ID}",
            user_data.id
        );
        if let Err(err) = s.discord.request("PUT", &role_path, None).await {
            error!("Failed to add role to user: {err}");
        }
    }

    let revoke_auth = basic_auth_header(client_id, client_secret);
    let revoke_ok = matches!(
        post_form(
            &s,
            "https://discord.com/api/v10/oauth2/token/revoke",
            Some(&revoke_auth),
            &[
                ("token", &token_data.access_token),
                ("token_type_hint", "access_token"),
            ],
        )
        .await,
        Ok(resp) if (200..300).contains(&resp.status)
    );

    if !revoke_ok {
        return Ok(redirect(
            "https://egdata.app/?error=discord-revoke-token-failed",
        ));
    }

    Ok(redirect("https://egdata.app/discord-linked"))
}

#[cfg(test)]
#[tokio::test]
async fn legacy_auth_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../egdata-api/tests/fixtures/legacy-auth-http-node.json"
    ))
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_api_test_support::test_app_state;
    use crate::state::ApiConfig;
    use async_trait::async_trait;
    use axum::{Router, routing::get};
    use chrono::TimeZone;
    use egdata_core::ports::{
        DiscordPort, MongoFindOptions, MongoStorePort, ResponseCachePort, SessionVerifierPort,
        TelegramPort, UpstreamHttpPort,
    };
    use http_body_util::BodyExt;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const TEST_RSA_PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCd/FbZwtp46BiP\n\
shlLzk/2KPdWZ2HBNg9e6PwpHnygw3GR2BzcLkDdrA4nV44bNmmejSDjLq5tbP6v\n\
KmAyZRoxm2Ejx+Lxs0plGreQL8qo4glXmk6gu9QQKuHajKvwLlNgP3m8YNkZ4CRm\n\
Hq3NXwBzxo0NiDeIJV3o/O55hwlmKEloeSRBoTkkgOV+AZphEenxdO1KfA5F7gNH\n\
4/9EdI2BzG235NI4s19q8NUzK6rrbDVDiJzS24fjciAKAW68abKWMRbysy1jSuB+\n\
SZV9/7Wv6kG7GWI7EOJLG9dEUT8GrbU7HRE47o4b+Luyt+Uq8iUIASLWAKMECM0v\n\
8gPN3YYdAgMBAAECggEAXPQ7paSgJsNosCN5/sBFC/DOlmf9fFDyekVbGFZ3vZ9B\n\
Ey60zFfqkoLJURyS4DADtOYUk5bDyl52+1lTgFM8NjPV09eoD84N168AkjWMaBGW\n\
rZR87tWU0G5qtMxP3eFj7R1r4wqYskDPKcajPFLJUVVhaLTc954EwzEOnzJ0tUXS\n\
KLY4q0y/9FPUjG6wCePq9ImMDF/3L51AxTDKuQSw55t8gqVNCR1vQiKEMAKi3bb5\n\
wQfa+rlKemb4e3iTcdXrYtAwvD1qmOWv5d1nyp+u2mX9AuDIfu4j/faToTRDg05x\n\
HGZM84jv4rOeeHCO0R7w144lXjegAStecmjmmpXJgQKBgQDDNaaNltCY5vQAl9Os\n\
ZUY3IO/TszRHNt68PbDraevUv2UWeiS1S1EMEm4lGb+8L7Y1YaXg72pRN3P5IGi0\n\
WXbZlGDBdTYs7NIzDKX2oMSQkmNZhJEzTcxLykBv2k/aaKu6+XRiESP67nquXe8F\n\
JQaDFvKUxy7WY0yu21UJPLd/9wKBgQDPLyfFZU71NmiBryJEtjFSoCh3/B0NRpXc\n\
X+l3AHW/eeBorKLnS23ZMOCMSPb19ENVjVIVT95gmxfx/ycuhspJ3YO5C7wNsuk3\n\
dV/4rSsKz6Hx7UCDRUia4mgj6P88u6GaXtJDD21Jl+fX7Tj/4RNY7C1hXJhzPCve\n\
ZfwzsUCNiwKBgCjdF0N2ea44UoW5QqdI//zUWT/wuJXbx56SL3HoV2TOuAOPiBWn\n\
cYzcYtBDZp6nQjZEfavrkk70E8Pn4+M1Aysi42o79h5LaOkk0a0iFGPLMR7xIFAk\n\
DgsjiH+hrKuk06YtSA6rVePWfjn4Eev6xzUz3Y4FcCmS2d+UrGVln2gbAoGBAMIc\n\
six1gIaqFTv7tCWgdZGuUHwqD6YSjfHNQtWl7qwZKjGoHXCK8T5eVuPYsNk7o6KS\n\
J2ekTvtAFC09G56x1vFhwzoqTmSfTXYSWHqK9BrK8jXSTXEwBphmq5+JeymRuhUB\n\
5gnCeGhNFIDv10mVvSTBErt3n7XHmGpkLujXl12FAoGAT6zpUUkBqW8+6pjBQPDX\n\
01wQNfw7FlWUwkdoCcdBrvpy6ejC9W7aLKLry88aecrLbQilfXJEKNK9f+CtNruD\n\
UygluIXe0w9BE1lANYZ7j+EGbpR4mtfUSVRVw/mqQcxCmPXig+4mXad7kAZlPcy0\n\
eLFyuFOYZ8JWwX4uPiGYpCA=\n\
-----END PRIVATE KEY-----";

    const TEST_RSA_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnfxW2cLaeOgYj7IZS85P\n\
9ij3VmdhwTYPXuj8KR58oMNxkdgc3C5A3awOJ1eOGzZpno0g4y6ubWz+rypgMmUa\n\
MZthI8fi8bNKZRq3kC/KqOIJV5pOoLvUECrh2oyr8C5TYD95vGDZGeAkZh6tzV8A\n\
c8aNDYg3iCVd6PzueYcJZihJaHkkQaE5JIDlfgGaYRHp8XTtSnwORe4DR+P/RHSN\n\
gcxtt+TSOLNfavDVMyuq62w1Q4ic0tuH43IgCgFuvGmyljEW8rMtY0rgfkmVff+1\n\
r+pBuxliOxDiSxvXRFE/Bq21Ox0ROO6OG/i7srflKvIlCAEi1gCjBAjNL/IDzd2G\n\
HQIDAQAB\n\
-----END PUBLIC KEY-----";

    mod failures {
        include!("auth/failures.rs");
    }
    mod oracle {
        include!("auth/oracle.rs");
    }

    fn fixed_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 6, 1, 12, 0, 0).unwrap()
    }

    fn make_unsigned_jwt(claims: &Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        format!("{header}.{payload}.sig")
    }

    fn sign_rs256(claims: &Value) -> String {
        encode(
            &Header::new(Algorithm::RS256),
            claims,
            &EncodingKey::from_rsa_pem(TEST_RSA_PRIVATE_PEM.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    #[derive(Default)]
    struct MockMongo {
        fault: Mutex<Option<(String, usize)>>,
        collections: Mutex<HashMap<String, Vec<Document>>>,
    }

    impl MockMongo {
        fn fail_on(&self, collection: &str, method: &str, occurrence: usize) {
            *self.fault.lock().unwrap() = Some((format!("{collection}.{method}"), occurrence));
        }

        fn check(&self, collection: &str, method: &str) -> std::result::Result<(), CoreError> {
            let mut fault = self.fault.lock().unwrap();
            if let Some((name, count)) = fault.as_mut()
                && name == &format!("{collection}.{method}")
            {
                *count -= 1;
                if *count == 0 {
                    *fault = None;
                    return Err(CoreError::Internal("fixture storage failure".into()));
                }
            }
            Ok(())
        }

        fn apply_update(
            &self,
            collection: &str,
            filter: Document,
            update: Document,
            upsert: bool,
        ) -> (u64, Option<Bson>) {
            let mut guard = self.collections.lock().unwrap();
            let docs = guard.entry(collection.to_string()).or_default();
            let set_doc = update.get_document("$set").cloned().unwrap_or_default();
            if let Some(existing) = docs.iter_mut().find(|d| matches_filter(d, &filter)) {
                for (k, v) in set_doc {
                    existing.insert(k, v);
                }
                return (1, None);
            }
            if upsert {
                let mut new_doc = Document::new();
                new_doc.insert("_id", ObjectId::new());
                for (k, v) in filter {
                    if let Bson::Document(inner) = v {
                        if let Some(eq_val) = inner.get("$eq") {
                            new_doc.insert(k, eq_val.clone());
                        }
                    } else {
                        new_doc.insert(k, v);
                    }
                }
                for (k, v) in set_doc {
                    new_doc.insert(k, v);
                }
                let id = new_doc.get("_id").cloned();
                docs.push(new_doc);
                return (1, id);
            }
            (0, None)
        }

        fn insert(&self, col: &str, doc: Document) {
            self.collections
                .lock()
                .unwrap()
                .entry(col.to_string())
                .or_default()
                .push(doc);
        }

        fn all(&self, col: &str) -> Vec<Document> {
            self.collections
                .lock()
                .unwrap()
                .get(col)
                .cloned()
                .unwrap_or_default()
        }
    }

    fn matches_filter(doc: &Document, filter: &Document) -> bool {
        for (k, v) in filter {
            let doc_val = doc.get(k);
            match v {
                Bson::Document(cond) => {
                    if let Some(eq_val) = cond.get("$eq") {
                        if doc_val != Some(eq_val) {
                            return false;
                        }
                    } else if let Some(Bson::DateTime(lt_dt)) = cond.get("$lt") {
                        let Some(Bson::DateTime(doc_dt)) = doc_val else {
                            return false;
                        };
                        if doc_dt >= lt_dt {
                            return false;
                        }
                    }
                }
                _ => {
                    if doc_val != Some(v) {
                        return false;
                    }
                }
            }
        }
        true
    }

    #[async_trait]
    impl MongoStorePort for MockMongo {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            _projection: Option<Document>,
        ) -> std::result::Result<Option<Document>, CoreError> {
            self.check(collection, "find_one")?;
            let guard = self.collections.lock().unwrap();
            let found = guard
                .get(collection)
                .and_then(|docs| docs.iter().find(|d| matches_filter(d, &filter)).cloned());
            Ok(found)
        }

        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            _options: MongoFindOptions,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            self.check(collection, "find_many")?;
            let guard = self.collections.lock().unwrap();
            let rows = guard
                .get(collection)
                .map(|docs| {
                    docs.iter()
                        .filter(|d| matches_filter(d, &filter))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            Ok(rows)
        }

        async fn aggregate(
            &self,
            _c: &str,
            _p: Vec<Document>,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            Ok(vec![])
        }

        async fn count_documents(
            &self,
            _c: &str,
            _f: Document,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }

        async fn distinct(
            &self,
            _c: &str,
            _field: &str,
            _f: Document,
        ) -> std::result::Result<Vec<Bson>, CoreError> {
            Ok(vec![])
        }

        async fn insert_one(
            &self,
            collection: &str,
            mut doc: Document,
        ) -> std::result::Result<(), CoreError> {
            if !doc.contains_key("_id") {
                doc.insert("_id", ObjectId::new());
            }
            self.insert(collection, doc);
            Ok(())
        }

        async fn update_one(
            &self,
            collection: &str,
            filter: Document,
            update: Document,
            upsert: bool,
        ) -> std::result::Result<u64, CoreError> {
            self.check(collection, "update_one")?;
            Ok(self.apply_update(collection, filter, update, upsert).0)
        }

        async fn upsert_one_returning_id(
            &self,
            collection: &str,
            filter: Document,
            update: Document,
        ) -> std::result::Result<Option<Bson>, CoreError> {
            Ok(self.apply_update(collection, filter, update, true).1)
        }

        async fn delete_one(
            &self,
            collection: &str,
            filter: Document,
        ) -> std::result::Result<u64, CoreError> {
            self.check(collection, "delete_one")?;
            let mut guard = self.collections.lock().unwrap();
            let Some(docs) = guard.get_mut(collection) else {
                return Ok(0);
            };
            if let Some(pos) = docs.iter().position(|d| matches_filter(d, &filter)) {
                docs.remove(pos);
                return Ok(1);
            }
            Ok(0)
        }

        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[derive(Default)]
    struct MockRedis {
        fail: std::sync::atomic::AtomicBool,
        store: Mutex<HashMap<String, (String, u64)>>,
    }

    #[async_trait]
    impl ResponseCachePort for MockRedis {
        async fn get(&self, key: &str) -> std::result::Result<Option<String>, CoreError> {
            Ok(self.store.lock().unwrap().get(key).map(|(v, _)| v.clone()))
        }

        async fn set(
            &self,
            key: &str,
            value: &str,
            ttl_seconds: u64,
        ) -> std::result::Result<(), CoreError> {
            if self.fail.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(CoreError::Internal("fixture redis failure".into()));
            }
            self.store
                .lock()
                .unwrap()
                .insert(key.to_string(), (value.to_string(), ttl_seconds));
            Ok(())
        }

        async fn del(&self, key: &str) -> std::result::Result<(), CoreError> {
            self.store.lock().unwrap().remove(key);
            Ok(())
        }

        async fn consume(&self, key: &str) -> std::result::Result<bool, CoreError> {
            if self.fail.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(CoreError::Internal("fixture redis failure".into()));
            }
            Ok(self.store.lock().unwrap().remove(key).is_some())
        }

        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    struct MockSessionVerifier(Option<VerifiedSession>);

    #[async_trait]
    impl SessionVerifierPort for MockSessionVerifier {
        async fn verify_token(
            &self,
            cookie: &str,
        ) -> std::result::Result<Option<VerifiedSession>, CoreError> {
            if cookie.contains("better-auth.session_token=valid") {
                Ok(self.0.clone())
            } else {
                Ok(None)
            }
        }
    }

    #[derive(Default)]
    struct MockTelegram {
        messages: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl TelegramPort for MockTelegram {
        async fn send_message(&self, message: &str) -> std::result::Result<(), CoreError> {
            self.messages.lock().unwrap().push(message.to_string());
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockDiscord {
        calls: Mutex<Vec<(String, String)>>,
        fail: Mutex<bool>,
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
            if *self.fail.lock().unwrap() {
                return Err(CoreError::Upstream("discord fail".into()));
            }
            Ok(json!({}))
        }
    }

    type HttpResponder = Box<
        dyn Fn(&UpstreamHttpRequest) -> std::result::Result<UpstreamHttpResponse, CoreError>
            + Send
            + Sync,
    >;

    struct MockHttp {
        requests: Mutex<Vec<UpstreamHttpRequest>>,
        handler: HttpResponder,
    }

    impl MockHttp {
        fn new<F>(f: F) -> Self
        where
            F: Fn(&UpstreamHttpRequest) -> std::result::Result<UpstreamHttpResponse, CoreError>
                + Send
                + Sync
                + 'static,
        {
            Self {
                requests: Mutex::new(Vec::new()),
                handler: Box::new(f),
            }
        }
    }

    #[async_trait]
    impl UpstreamHttpPort for MockHttp {
        async fn send(
            &self,
            request: UpstreamHttpRequest,
        ) -> std::result::Result<UpstreamHttpResponse, CoreError> {
            self.requests.lock().unwrap().push(request.clone());
            (self.handler)(&request)
        }
    }

    struct TestEnv {
        state: AppState,
        mongo: Arc<MockMongo>,
        redis: Arc<MockRedis>,
        telegram: Arc<MockTelegram>,
        discord: Arc<MockDiscord>,
    }

    fn setup_env(http: Arc<dyn UpstreamHttpPort>, session: Option<VerifiedSession>) -> TestEnv {
        let config = ApiConfig {
            jwt_secret: "super-secret".into(),
            epic_client_id: Some("epic-client-id".into()),
            epic_client_secret: Some("epic-client-secret".into()),
            admin_account_id: Some("admin-acc".into()),
            jwt_public_key_pem: Some(TEST_RSA_PUBLIC_PEM.into()),
            discord_client_secret: Some("discord-secret".into()),
            ..Default::default()
        };

        let mongo = Arc::new(MockMongo::default());
        let redis = Arc::new(MockRedis::default());
        let telegram = Arc::new(MockTelegram::default());
        let discord = Arc::new(MockDiscord::default());

        let mut state = test_app_state(config);
        state.now = fixed_now;
        state.mongo = mongo.clone();
        state.saved_queries = redis.clone();
        state.session_verifier = Arc::new(MockSessionVerifier(session));
        state.telegram = telegram.clone();
        state.discord = discord.clone();
        state.http = http;

        TestEnv {
            state,
            mongo,
            redis,
            telegram,
            discord,
        }
    }

    fn sample_session(email: &str) -> VerifiedSession {
        let mut claims = BTreeMap::new();
        claims.insert("email".into(), json!(email));
        claims.insert("sessionId".into(), json!("browser-session"));
        claims.insert(
            "epicAccountId".into(),
            json!(email.split_once('@').map(|(id, _)| id)),
        );
        VerifiedSession {
            subject: "user-1".into(),
            claims,
        }
    }

    fn router_for(state: &AppState) -> Router {
        crate::router(state).with_state(state.clone())
    }

    async fn json_body(resp: Response) -> Value {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn epic_token_info_ok(account_id: &str) -> UpstreamHttpResponse {
        UpstreamHttpResponse {
            status: 200,
            body: serde_json::to_vec(&json!({
                "active": true,
                "scope": "basic_profile",
                "token_type": "bearer",
                "expires_in": 3600,
                "expires_at": "2026-06-01T13:00:00.000Z",
                "account_id": account_id,
                "client_id": "epic-client-id",
                "application_id": "app-1"
            }))
            .unwrap(),
        }
    }

    #[tokio::test]
    async fn cors_handles_allowed_disallowed_and_preflight() {
        let app = Router::new()
            .route("/test", get(|| async { "ok" }))
            .layer(middleware::from_fn(auth_cors));

        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/test")
                    .header(header::ORIGIN, "http://localhost:3001")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "http://localhost:3001"
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                .unwrap(),
            "true"
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_MAX_AGE)
                .unwrap(),
            "86400"
        );

        let disallowed_preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/test")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            disallowed_preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "https://egdata.app"
        );

        let get_req = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/test")
                    .header(header::ORIGIN, "https://store.epicgames.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_req.status(), StatusCode::OK);
        assert_eq!(
            get_req
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "https://store.epicgames.com"
        );
    }

    #[tokio::test]
    async fn epic_and_epic_info_cover_all_auth_branches() {
        let valid_jwt = make_unsigned_jwt(&json!({ "sub": "acc-1", "appid": "app-1" }));
        let missing_claims_jwt = make_unsigned_jwt(&json!({ "sub": "" }));

        let http = Arc::new(MockHttp::new(|req| {
            let tok = url::form_urlencoded::parse(req.body.as_deref().unwrap_or(&[]))
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let sub = decode_jwt_payload(&tok)
                .and_then(|v| v.get("sub").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            if sub == "transport-err" {
                return Err(CoreError::Upstream("network".into()));
            }
            if sub == "bad-status" {
                return Ok(UpstreamHttpResponse {
                    status: 401,
                    body: b"{}".to_vec(),
                });
            }
            if sub == "bad-json" {
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: b"not-json".to_vec(),
                });
            }
            if sub == "inactive" {
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: br#"{"active":false,"account_id":""}"#.to_vec(),
                });
            }
            Ok(epic_token_info_ok("acc-1"))
        }));

        let env = setup_env(http, Some(sample_session("acc-sess@epic.egdata.app")));

        // Missing header/cookie
        let missing = epic(&env.state, &HeaderMap::new()).await;
        assert!(missing.is_err());

        // Cookie session succeeds
        let mut hm = HeaderMap::new();
        hm.insert(
            header::COOKIE,
            HeaderValue::from_static("better-auth.session_token=valid"),
        );
        let sess_ctx = epic(&env.state, &hm).await.ok().unwrap();
        assert_eq!(sess_ctx.account_id(), Some("acc-sess"));

        // Invalid JWT variants
        for bad in ["not-a-jwt", "a.b.c.d", "a.!!!.c", &missing_claims_jwt] {
            let mut h = HeaderMap::new();
            h.insert(header::AUTHORIZATION, HeaderValue::from_str(bad).unwrap());
            assert!(epic(&env.state, &h).await.is_err());
        }

        // Upstream tokenInfo failure variants
        for sub_tag in ["transport-err", "bad-status", "bad-json", "inactive"] {
            let tok = make_unsigned_jwt(&json!({ "sub": sub_tag, "appid": "app-1" }));
            let mut h = HeaderMap::new();
            h.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {tok}")).unwrap(),
            );
            assert!(epic(&env.state, &h).await.is_err());
            assert!(epic_info(&env.state, &h).await.is_none());
        }

        // EPIC_AUTH cookie fallback + epic_info success
        let mut cookie_hdr = HeaderMap::new();
        cookie_hdr.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("EPIC_AUTH={valid_jwt}")).unwrap(),
        );
        let ctx = epic(&env.state, &cookie_hdr).await.ok().unwrap();
        assert_eq!(ctx.epic.as_ref().unwrap().account_id, "acc-1");
        assert!(epic_info(&env.state, &cookie_hdr).await.is_some());
        assert!(epic_info(&env.state, &HeaderMap::new()).await.is_none());
    }

    #[tokio::test]
    async fn get_account_fetches_inserts_and_returns_cached() {
        let jwt = make_unsigned_jwt(&json!({ "sub": "acc-1", "appid": "app-1" }));
        let fail_profile = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let fail_flag = fail_profile.clone();

        let http = Arc::new(MockHttp::new(move |req| {
            if req.url == EPIC_TOKEN_INFO_URL {
                return Ok(epic_token_info_ok("acc-1"));
            }
            if req.url.starts_with(EPIC_ACCOUNTS_URL) {
                if fail_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    return Ok(UpstreamHttpResponse {
                        status: 200,
                        body: b"[]".to_vec(),
                    });
                }
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!([{
                        "accountId": "acc-1",
                        "displayName": "PlayerOne",
                        "preferredLanguage": "en"
                    }]))
                    .unwrap(),
                });
            }
            unreachable!()
        }));

        let env = setup_env(http, Some(sample_session("acc-1@epic.egdata.app")));
        let app = router_for(&env.state);

        // Session-only auth lacks epic var -> 401
        let r_sess = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth")
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_sess.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(r_sess).await["error"], "Missing EPIC_ACCOUNT_ID");

        // Epic profile empty -> 401
        let r_miss = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth")
                    .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_miss.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json_body(r_miss).await["error"],
            "Failed to fetch Epic profile"
        );

        // Epic profile found -> inserts into DB and returns profile
        fail_profile.store(false, std::sync::atomic::Ordering::Relaxed);
        let r_ok = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth")
                    .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_ok.status(), StatusCode::OK);
        let b_ok = json_body(r_ok).await;
        assert_eq!(b_ok["displayName"], "PlayerOne");
        assert!(b_ok.get("creationDate").is_none());
        assert_eq!(env.mongo.all("epic").len(), 1);

        // Second call returns DB entry (with creationDate)
        let r_db = app
            .oneshot(
                Request::builder()
                    .uri("/auth")
                    .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_db.status(), StatusCode::OK);
        assert!(json_body(r_db).await.get("creationDate").is_some());
    }

    #[tokio::test]
    async fn upload_avatar_handles_multipart_cloudflare_and_errors() {
        let jwt = make_unsigned_jwt(&json!({ "sub": "acc-1", "appid": "app-1" }));
        let mode = Arc::new(Mutex::new("ok"));
        let mode_clone = mode.clone();

        let http = Arc::new(MockHttp::new(move |req| {
            if req.url == EPIC_TOKEN_INFO_URL {
                return Ok(epic_token_info_ok("acc-1"));
            }
            assert!(req.url.contains("/images/v1"));
            match *mode_clone.lock().unwrap() {
                "transport" => Err(CoreError::Upstream("cf down".into())),
                "http400" => Ok(UpstreamHttpResponse {
                    status: 400,
                    body: b"{}".to_vec(),
                }),
                "badjson" => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: b"not-json".to_vec(),
                }),
                _ => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "result": {
                            "id": "img-1",
                            "variants": ["https://imagedelivery.net/x/img-1/public"]
                        }
                    }))
                    .unwrap(),
                }),
            }
        }));

        let env = setup_env(
            http.clone(),
            Some(VerifiedSession {
                subject: "u".into(),
                claims: BTreeMap::new(),
            }),
        );
        env.mongo.insert("epic", doc! { "accountId": "acc-1" });

        // Session without email -> 401
        let app = router_for(&env.state);
        let r_no_email = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/avatar")
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_no_email.status(), StatusCode::UNAUTHORIZED);

        // Missing multipart content-type -> 400
        let r_no_mp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/avatar")
                    .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .body(Body::from("plain"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_no_mp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(r_no_mp).await["error"], "Missing file");

        // Multipart missing avatar field -> 400
        let boundary = "BOUNDARY123";
        let other_body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"other\"\r\n\r\nhello\r\n--{boundary}--\r\n"
        );
        let r_no_avatar = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/avatar")
                    .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(other_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_no_avatar.status(), StatusCode::BAD_REQUEST);

        let make_avatar_req = || {
            let body = format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"avatar\"; filename=\"pic.webp\"\r\nContent-Type: image/webp\r\n\r\nBYTES\r\n--{boundary}--\r\n"
            );
            Request::builder()
                .method(Method::POST)
                .uri("/auth/avatar")
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap()
        };

        for err_mode in ["transport", "badjson"] {
            *mode.lock().unwrap() = err_mode;
            let resp = app.clone().oneshot(make_avatar_req()).await.unwrap();
            assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        }
        *mode.lock().unwrap() = "http400";
        let resp = app.clone().oneshot(make_avatar_req()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(resp).await["error"], "Failed to upload avatar");

        // Success
        *mode.lock().unwrap() = "ok";
        let r_ok = app.oneshot(make_avatar_req()).await.unwrap();
        assert_eq!(r_ok.status(), StatusCode::OK);
        assert_eq!(json_body(r_ok).await["id"], "img-1");
        let epic_doc = env.mongo.all("epic").into_iter().next().unwrap();
        assert_eq!(
            epic_doc
                .get_document("avatarUrl")
                .unwrap()
                .get_str("id")
                .unwrap(),
            "img-1"
        );
        let last_req = http.requests.lock().unwrap().last().unwrap().clone();
        assert!(last_req.url.contains(DEFAULT_CF_ACCOUNT_ID));
        assert_eq!(last_req.multipart_file.unwrap().filename, "acc-1.webp");
    }

    #[tokio::test]
    async fn persist_validates_tokens_and_upserts() {
        let access_jwt = make_unsigned_jwt(&json!({ "sub": "acc-1", "appid": "app-1" }));
        let refresh_jwt = make_unsigned_jwt(&json!({ "jti": "jti-1" }));
        let no_jti_jwt = make_unsigned_jwt(&json!({ "sub": "acc-1" }));

        let mode = Arc::new(Mutex::new("ok"));
        let mode_clone = mode.clone();
        let http = Arc::new(MockHttp::new(move |req| {
            let body = String::from_utf8_lossy(req.body.as_deref().unwrap_or(&[]));
            let is_refresh = body.contains(&refresh_jwt);
            match *mode_clone.lock().unwrap() {
                "badjson" if is_refresh => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: b"bad".to_vec(),
                }),
                "inactive" if is_refresh => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: br#"{"active":false,"account_id":"acc-1"}"#.to_vec(),
                }),
                "mismatch" if is_refresh => Ok(epic_token_info_ok("other-acc")),
                _ => Ok(epic_token_info_ok("acc-1")),
            }
        }));

        let env = setup_env(http, Some(sample_session("acc-1@epic.egdata.app")));
        let app = router_for(&env.state);

        // Session only -> 401
        let r_sess = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/persist")
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_sess.status(), StatusCode::UNAUTHORIZED);

        // Bad JSON / non-jwt / missing jti -> 400
        for bad_body in [
            "not-json".to_string(),
            json!({ "refreshToken": "bad" }).to_string(),
            json!({ "refreshToken": no_jti_jwt }).to_string(),
        ] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/auth/persist")
                        .header(header::AUTHORIZATION, format!("Bearer {access_jwt}"))
                        .body(Body::from(bad_body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }

        let valid_refresh = make_unsigned_jwt(&json!({ "jti": "jti-1" }));
        let make_req = || {
            Request::builder()
                .method(Method::POST)
                .uri("/auth/persist")
                .header(header::AUTHORIZATION, format!("Bearer {access_jwt}"))
                .body(Body::from(
                    json!({ "refreshToken": valid_refresh }).to_string(),
                ))
                .unwrap()
        };

        *mode.lock().unwrap() = "badjson";
        let resp = app.clone().oneshot(make_req()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        *mode.lock().unwrap() = "inactive";
        let resp = app.clone().oneshot(make_req()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json_body(resp).await["error"], "Invalid tokens");

        *mode.lock().unwrap() = "mismatch";
        let r_mis = app.clone().oneshot(make_req()).await.unwrap();
        assert_eq!(r_mis.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json_body(r_mis).await["error"],
            "Tokens are not for the same account"
        );

        // Insert new -> returns id string
        *mode.lock().unwrap() = "ok";
        let r_insert = app.clone().oneshot(make_req()).await.unwrap();
        assert_eq!(r_insert.status(), StatusCode::OK);
        let b_insert = json_body(r_insert).await;
        assert_eq!(b_insert["status"], "ok");
        assert!(b_insert["id"].is_string());

        // Update existing -> returns id: null
        let r_update = app.oneshot(make_req()).await.unwrap();
        assert_eq!(r_update.status(), StatusCode::OK);
        assert_eq!(
            json_body(r_update).await,
            json!({ "id": null, "status": "ok" })
        );
    }

    #[tokio::test]
    async fn get_refresh_validates_jwt_queries_mongo_and_refreshes_if_expired() {
        let mode = Arc::new(Mutex::new("ok"));
        let mode_clone = mode.clone();
        let (signing_key, _, jwk) = crate::account_admin::tests::rsa_keypair_pem();
        let http = Arc::new(MockHttp::new(move |req| {
            if req.url == EPIC_TOKEN_INFO_URL {
                return Ok(epic_token_info_ok(match *mode_clone.lock().unwrap() {
                    "other-account" => "acc-2",
                    _ => "acc-1",
                }));
            }
            if req.url == EPIC_JWKS_URL {
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({"keys":[&jwk]})).unwrap(),
                });
            }
            match *mode_clone.lock().unwrap() {
                "err" => Ok(UpstreamHttpResponse {
                    status: 400,
                    body: b"{}".to_vec(),
                }),
                "baddate" => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "access_token": "new-acc",
                        "refresh_token": "new-ref",
                        "expires_at": "bad-date",
                        "refresh_expires_at": "2026-07-01T00:00:00.000Z"
                    }))
                    .unwrap(),
                }),
                "badrefreshdate" => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "access_token": "new-acc",
                        "refresh_token": "new-ref",
                        "expires_at": "2026-06-01T14:00:00.000Z",
                        "refresh_expires_at": "bad-date"
                    }))
                    .unwrap(),
                }),
                _ => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "access_token": "new-acc",
                        "refresh_token": "new-ref",
                        "expires_at": "2026-06-01T14:00:00.000Z",
                        "refresh_expires_at": "2026-07-01T00:00:00.000Z"
                    }))
                    .unwrap(),
                }),
            }
        }));

        let env = setup_env(http, None);
        let app = router_for(&env.state);

        // Missing auth / empty token
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/auth/refresh")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/auth/refresh")
                        .header(header::AUTHORIZATION, "Bearer ")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        // Invalid token claims
        let bad_tokens = [
            "bad".to_string(),
            make_unsigned_jwt(
                &json!({ "iss": "https://api.epicgames.dev/epic/id", "aud": "epic-client-id" }),
            ),
            make_unsigned_jwt(&json!({ "sub": "acc-1", "aud": "epic-client-id" })),
            make_unsigned_jwt(
                &json!({ "sub": "acc-1", "iss": "https://other.example/", "aud": "epic-client-id" }),
            ),
            make_unsigned_jwt(
                &json!({ "sub": "acc-1", "iss": "https://api.epicgames.dev/epic/id", "aud": "wrong" }),
            ),
        ];
        for tok in bad_tokens {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/auth/refresh")
                        .header(header::AUTHORIZATION, format!("Bearer {tok}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }

        let mut key_header = Header::new(Algorithm::RS256);
        key_header.kid = Some("kid-1".into());
        let valid_tok = encode(
            &key_header,
            &json!({
                "exp":fixed_now().timestamp()+3600,"iat":fixed_now().timestamp()-60,
                "sub": "acc-1",
                "iss": "https://api.epicgames.dev/epic/id",
                "aud": "epic-client-id"
            }),
            &EncodingKey::from_rsa_pem(signing_key.as_bytes()).unwrap(),
        )
        .unwrap();

        let unsigned = make_unsigned_jwt(
            &json!({"sub":"acc-1","iss":"https://api.epicgames.dev/epic/id","aud":"epic-client-id"}),
        );
        let rejected = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={}", ObjectId::new()))
                    .header(header::AUTHORIZATION, format!("Bearer {unsigned}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
        // Missing / invalid id param
        for uri in ["/auth/refresh", "/auth/refresh?id=not-an-oid"] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(header::AUTHORIZATION, format!("Bearer {valid_tok}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }

        // Not found
        let oid = ObjectId::new();
        let r_404 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={}", oid.to_hex()))
                    .header(header::AUTHORIZATION, format!("Bearer {valid_tok}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_404.status(), StatusCode::NOT_FOUND);

        // Unexpired token -> returns directly
        let future_dt = bson::DateTime::from_chrono(fixed_now() + Duration::hours(1));
        env.mongo.insert(
            "tokens",
            doc! {
                "_id": oid,
                "accountId": "acc-1",
                "accessToken": "old-acc",
                "refreshToken": "old-ref",
                "expiresAt": future_dt,
                "refreshExpiresAt": future_dt,
            },
        );
        let r_fresh = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={}", oid.to_hex()))
                    .header(header::AUTHORIZATION, format!("Bearer {valid_tok}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_fresh.status(), StatusCode::OK);
        assert_eq!(json_body(r_fresh).await["accessToken"], "old-acc");

        // OAuth access credentials require an active provider response bound to the account.
        let oauth = encode(
            &key_header,
            &json!({"sub":"acc-1","iss":"https://api.epicgames.dev/epic/oauth/v2",
                "aud":"epic-client-id","exp":fixed_now().timestamp()+3600}),
            &EncodingKey::from_rsa_pem(signing_key.as_bytes()).unwrap(),
        )
        .unwrap();
        for (provider, status) in [
            ("other-account", StatusCode::UNAUTHORIZED),
            ("ok", StatusCode::OK),
        ] {
            *mode.lock().unwrap() = provider;
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/auth/refresh?id={oid}"))
                        .header(header::AUTHORIZATION, format!("Bearer {oauth}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        let future_identity = encode(
            &key_header,
            &json!({"sub":"acc-1","iss":"https://api.epicgames.dev/epic/id",
                "aud":"epic-client-id","exp":fixed_now().timestamp()+3600,
                "iat":fixed_now().timestamp(),"nbf":fixed_now().timestamp()+1800}),
            &EncodingKey::from_rsa_pem(signing_key.as_bytes()).unwrap(),
        )
        .unwrap();
        let inactive = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={oid}"))
                    .header(header::AUTHORIZATION, format!("Bearer {future_identity}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(inactive.status(), StatusCode::UNAUTHORIZED);

        let expired_bearer=encode(&key_header,&json!({"sub":"acc-1","iss":"https://api.epicgames.dev/epic/id","aud":"epic-client-id","iat":0,"exp":1}),&EncodingKey::from_rsa_pem(signing_key.as_bytes()).unwrap()).unwrap();
        let wrong_record = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={oid}"))
                    .header(header::AUTHORIZATION, format!("Bearer {expired_bearer}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_record.status(), StatusCode::UNAUTHORIZED);
        let owned = ObjectId::new();
        env.mongo.insert("tokens",doc!{"_id":owned,"accountId":"acc-1","accessToken":&expired_bearer,"refreshToken":"ref","expiresAt":future_dt,"refreshExpiresAt":future_dt});
        let bound = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={owned}"))
                    .header(header::AUTHORIZATION, format!("Bearer {expired_bearer}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bound.status(), StatusCode::OK);
        assert_eq!(
            bound.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let past = bson::DateTime::from_chrono(fixed_now() - Duration::minutes(1));
        env.mongo
            .update_one(
                "tokens",
                doc! {"_id":owned},
                doc! {"$set":{"refreshExpiresAt":past}},
                false,
            )
            .await
            .unwrap();
        let expired = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={owned}"))
                    .header(header::AUTHORIZATION, format!("Bearer {expired_bearer}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(expired.status(), StatusCode::UNAUTHORIZED);

        // Expired token -> error branches then success
        let oid_exp = ObjectId::new();
        let past_dt = bson::DateTime::from_chrono(fixed_now() - Duration::hours(1));
        env.mongo.insert(
            "tokens",
            doc! {
                "_id": oid_exp,
                "accountId": "acc-1",
                "accessToken": "old-acc",
                "refreshToken": "old-ref",
                "expiresAt": past_dt,
                "refreshExpiresAt": future_dt,
            },
        );

        for err_mode in ["err", "baddate", "badrefreshdate"] {
            *mode.lock().unwrap() = err_mode;
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/auth/refresh?id={}", oid_exp.to_hex()))
                        .header(header::AUTHORIZATION, format!("Bearer {valid_tok}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }

        *mode.lock().unwrap() = "ok";
        let r_refreshed = app
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/refresh?id={}", oid_exp.to_hex()))
                    .header(header::AUTHORIZATION, format!("Bearer {valid_tok}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_refreshed.status(), StatusCode::OK);
        assert_eq!(json_body(r_refreshed).await["accessToken"], "new-acc");
    }

    #[tokio::test]
    async fn patch_refresh_processes_expired_valid_and_failed_tokens() {
        let http = Arc::new(MockHttp::new(|req| {
            let body = String::from_utf8_lossy(req.body.as_deref().unwrap_or(&[]));
            if body.contains("ref-http-json-err") {
                return Ok(UpstreamHttpResponse {
                    status: 400,
                    body: br#"{"errorCode":"invalid_grant"}"#.to_vec(),
                });
            }
            if body.contains("ref-http-bad-json") {
                return Ok(UpstreamHttpResponse {
                    status: 500,
                    body: b"oops".to_vec(),
                });
            }
            if body.contains("ref-revoke-err") || body.contains("ref-transport") {
                return Err(CoreError::Upstream("timeout".into()));
            }
            Ok(UpstreamHttpResponse {
                status: 200,
                body: serde_json::to_vec(&json!({
                    "access_token": "fresh-acc",
                    "refresh_token": "fresh-ref",
                    "expires_at": "2026-06-01T14:00:00.000Z",
                    "refresh_expires_at": "2026-07-01T00:00:00.000Z"
                }))
                .unwrap(),
            })
        }));

        let env = setup_env(http.clone(), None);
        let app = router_for(&env.state);

        // Unauthorized secret
        let r_unauth = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri("/auth/refresh")
                    .header(header::AUTHORIZATION, "Bearer wrong")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_unauth.status(), StatusCode::UNAUTHORIZED);

        let soon = bson::DateTime::from_chrono(fixed_now() + Duration::minutes(5));
        let past = bson::DateTime::from_chrono(fixed_now() - Duration::minutes(5));
        let future = bson::DateTime::from_chrono(fixed_now() + Duration::days(1));

        // 1. Expired refresh token -> deleted directly
        env.mongo.insert(
            "tokens",
            doc! { "tokenId": "t-expired", "refreshToken": "ref-exp", "expiresAt": soon, "refreshExpiresAt": past },
        );
        // 2. Valid refresh -> updated
        env.mongo.insert(
            "tokens",
            doc! { "tokenId": "t-ok", "refreshToken": "ref-ok", "expiresAt": soon, "refreshExpiresAt": future },
        );
        // 3. HTTP error with JSON -> telegram + delete
        env.mongo.insert(
            "tokens",
            doc! { "tokenId": "t-json-err", "refreshToken": "ref-http-json-err", "expiresAt": soon, "refreshExpiresAt": future },
        );
        // 4. HTTP error with non-JSON -> telegram + revoke + delete
        env.mongo.insert(
            "tokens",
            doc! { "tokenId": "t-bad-json", "refreshToken": "ref-http-bad-json", "expiresAt": soon, "refreshExpiresAt": future },
        );
        // 5. Transport error where revoke also fails -> telegram + revoke err + delete
        env.mongo.insert(
            "tokens",
            doc! { "tokenId": "t-revoke-err", "refreshToken": "ref-revoke-err", "expiresAt": soon, "refreshExpiresAt": future },
        );

        let r_ok = app
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri("/auth/refresh")
                    .header(header::AUTHORIZATION, "Bearer super-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_ok.status(), StatusCode::OK);
        assert_eq!(json_body(r_ok).await, json!({ "status": "ok" }));

        let remaining = env.mongo.all("tokens");
        assert_eq!(remaining.len(), 3);
        let updated = remaining
            .iter()
            .find(|r| r.get_str("tokenId") == Ok("t-ok"))
            .unwrap();
        assert_eq!(updated.get_str("accessToken").unwrap(), "fresh-acc");
        assert!(
            remaining
                .iter()
                .all(|r| r.get_str("tokenId") != Ok("t-expired")
                    && r.get_str("tokenId") != Ok("t-json-err"))
        );
        assert_eq!(env.telegram.messages.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn patch_refresh_admin_covers_auth_fresh_error_and_success() {
        let mode = Arc::new(Mutex::new("ok"));
        let mode_clone = mode.clone();
        let http = Arc::new(MockHttp::new(move |_| {
            match *mode_clone.lock().unwrap() {
            "transport" => Err(CoreError::Upstream("down".into())),
            "http500" => Ok(UpstreamHttpResponse {
                status: 500,
                body: b"{}".to_vec(),
            }),
            "badjson" => Ok(UpstreamHttpResponse {
                status: 200,
                body: b"bad".to_vec(),
            }),
            "baddate1" => Ok(UpstreamHttpResponse {
                status: 200,
                body: br#"{"access_token":"a","refresh_token":"r","expires_at":"bad","refresh_expires_at":"2026-07-01T00:00:00.000Z"}"#.to_vec(),
            }),
            "baddate2" => Ok(UpstreamHttpResponse {
                status: 200,
                body: br#"{"access_token":"a","refresh_token":"r","expires_at":"2026-06-01T14:00:00.000Z","refresh_expires_at":"bad"}"#.to_vec(),
            }),
            _ => Ok(UpstreamHttpResponse {
                status: 200,
                body: serde_json::to_vec(&json!({
                    "access_token": "admin-new",
                    "refresh_token": "admin-ref-new",
                    "expires_at": "2026-06-01T14:00:00.000Z",
                    "refresh_expires_at": "2026-07-01T00:00:00.000Z"
                }))
                .unwrap(),
            }),
        }
        }));

        let mut env = setup_env(http, None);
        let app = router_for(&env.state);

        // Auth checks
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri("/auth/refresh-admin")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri("/auth/refresh-admin")
                        .header(header::AUTHORIZATION, "Basic xyz")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri("/auth/refresh-admin")
                        .header(header::AUTHORIZATION, "Bearer bad")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        // User not found
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri("/auth/refresh-admin")
                        .header(header::AUTHORIZATION, "Bearer super-secret")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );

        // Not expired yet (using ISO string date to test parse_bson_datetime string branch)
        env.mongo.insert(
            "launcher",
            doc! {
                "account_id": "admin-acc",
                "refresh_token": "adm-ref",
                "expires_at": "2026-06-01T13:00:00.000Z"
            },
        );
        let r_fresh = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri("/auth/refresh-admin")
                    .header(header::AUTHORIZATION, "Bearer super-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_fresh.status(), StatusCode::OK);
        assert_eq!(json_body(r_fresh).await["message"], "Token is not expired");

        // Expired -> errors then success
        env.mongo.update_one(
            "launcher",
            doc! { "account_id": "admin-acc" },
            doc! { "$set": { "expires_at": bson::DateTime::from_chrono(fixed_now() - Duration::minutes(1)) } },
            false,
        ).await.unwrap();

        for err_mode in ["transport", "http500", "badjson", "baddate1", "baddate2"] {
            *mode.lock().unwrap() = err_mode;
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri("/auth/refresh-admin")
                        .header(header::AUTHORIZATION, "Bearer super-secret")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(env.telegram.messages.lock().unwrap().len(), 1);

        *mode.lock().unwrap() = "ok";
        let r_ok = app
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri("/auth/refresh-admin")
                    .header(header::AUTHORIZATION, "Bearer super-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_ok.status(), StatusCode::OK);
        assert_eq!(json_body(r_ok).await, json!({ "status": "ok" }));

        // Also cover admin_account_id: None
        let mut cfg_none = (*env.state.config).clone();
        cfg_none.admin_account_id = None;
        env.state.config = Arc::new(cfg_none);
        assert_eq!(
            router_for(&env.state)
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri("/auth/refresh-admin")
                        .header(header::AUTHORIZATION, "Bearer super-secret")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn v2_persist_and_v2_refresh_verify_rs256_and_manage_tokens() {
        let profile_empty = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pe_clone = profile_empty.clone();
        let http = Arc::new(MockHttp::new(move |req| {
            if req.url.starts_with(EPIC_ACCOUNTS_URL) {
                if pe_clone.load(std::sync::atomic::Ordering::Relaxed) {
                    return Ok(UpstreamHttpResponse {
                        status: 200,
                        body: b"[]".to_vec(),
                    });
                }
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!([{
                        "accountId": "acc-v2",
                        "displayName": "V2User"
                    }]))
                    .unwrap(),
                });
            }
            if req.url == EPIC_TOKEN_URL {
                let body = String::from_utf8_lossy(req.body.as_deref().unwrap_or(&[]));
                if body.contains("ref-fail") {
                    return Ok(UpstreamHttpResponse {
                        status: 400,
                        body: b"{}".to_vec(),
                    });
                }
                if body.contains("refresh_token=ref-baddate&") {
                    return Ok(UpstreamHttpResponse {
                        status: 200,
                        body: br#"{"access_token":"a","refresh_token":"r","expires_at":"bad","refresh_expires_at":"2026-07-01T00:00:00.000Z"}"#.to_vec(),
                    });
                }
                if body.contains("ref-baddate2") {
                    return Ok(UpstreamHttpResponse {
                        status: 200,
                        body: br#"{"access_token":"a","refresh_token":"r","expires_at":"2026-06-01T14:00:00.000Z","refresh_expires_at":"bad"}"#.to_vec(),
                    });
                }
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({
                        "access_token": "v2-fresh-acc",
                        "refresh_token": "v2-fresh-ref",
                        "expires_at": "2026-06-01T14:00:00.000Z",
                        "refresh_expires_at": "2026-07-01T00:00:00.000Z"
                    }))
                    .unwrap(),
                });
            }
            unreachable!()
        }));

        let mut env = setup_env(http, None);

        // Missing / invalid PEM
        let mut cfg_no_pem = (*env.state.config).clone();
        cfg_no_pem.jwt_public_key_pem = None;
        env.state.config = Arc::new(cfg_no_pem);
        assert_eq!(
            router_for(&env.state)
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/auth/v2/persist")
                        .header(header::AUTHORIZATION, "Bearer x")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let mut cfg_bad_pem = (*env.state.config).clone();
        cfg_bad_pem.jwt_public_key_pem = Some("NOT A PEM".into());
        env.state.config = Arc::new(cfg_bad_pem);
        assert_eq!(
            router_for(&env.state)
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/auth/v2/persist")
                        .header(header::AUTHORIZATION, "Bearer x")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        // Restore valid PEM
        let mut cfg_ok = (*env.state.config).clone();
        cfg_ok.jwt_public_key_pem = Some(TEST_RSA_PUBLIC_PEM.into());
        env.state.config = Arc::new(cfg_ok);
        let app = router_for(&env.state);

        // Bad RS256 / invalid inner tokens
        let bad_jwts = [
            "invalid.jwt".to_string(),
            sign_rs256(&json!({ "access_token": "", "jti": "j1" })),
            sign_rs256(
                &json!({ "access_token": "bad", "jti": "j1", "refresh_token": "r", "expires_at": "2026-06-01T13:00:00Z", "refresh_expires_at": "2026-07-01T00:00:00Z" }),
            ),
            sign_rs256(
                &json!({ "access_token": make_unsigned_jwt(&json!({ "iss": "x" })), "jti": "j1", "refresh_token": "r", "expires_at": "2026-06-01T13:00:00Z", "refresh_expires_at": "2026-07-01T00:00:00Z" }),
            ),
            sign_rs256(
                &json!({ "access_token": make_unsigned_jwt(&json!({ "sub": "acc-v2" })), "jti": "j1", "refresh_token": "r", "expires_at": "2026-06-01T13:00:00Z", "refresh_expires_at": "2026-07-01T00:00:00Z" }),
            ),
            sign_rs256(
                &json!({ "access_token": make_unsigned_jwt(&json!({ "sub": "acc-v2", "iss": "x" })), "jti": "j1", "refresh_token": "r", "expires_at": "bad", "refresh_expires_at": "2026-07-01T00:00:00Z" }),
            ),
            sign_rs256(
                &json!({ "access_token": make_unsigned_jwt(&json!({ "sub": "acc-v2", "iss": "x" })), "jti": "j1", "refresh_token": "r", "expires_at": "2026-06-01T13:00:00Z", "refresh_expires_at": "bad" }),
            ),
        ];
        for tok in bad_jwts {
            let r = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/auth/v2/persist")
                        .header(header::AUTHORIZATION, format!("Bearer {tok}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        }

        // Valid v2 persist (creates epic entry with profile)
        let inner_access = make_unsigned_jwt(
            &json!({ "sub": "acc-v2", "iss": "https://api.epicgames.dev/epic/id" }),
        );
        let v2_jwt = sign_rs256(&json!({
            "access_token": inner_access,
            "refresh_token": "ref-v2",
            "expires_at": "2026-06-01T13:00:00.000Z",
            "refresh_expires_at": "2026-07-01T00:00:00.000Z",
            "jti": "jti-v2"
        }));
        let r_persist = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/v2/persist")
                    .header(header::AUTHORIZATION, format!("Bearer {v2_jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_persist.status(), StatusCode::OK);
        assert_eq!(
            json_body(r_persist).await,
            json!({ "id": "jti-v2", "status": "ok" })
        );
        assert_eq!(env.mongo.all("epic").len(), 1);

        // Valid v2 persist when epic missing and get_epic_account returns None
        profile_empty.store(true, std::sync::atomic::Ordering::Relaxed);
        let inner_access2 = make_unsigned_jwt(&json!({ "sub": "acc-v2-none", "iss": "x" }));
        let v2_jwt2 = sign_rs256(&json!({
            "access_token": inner_access2,
            "refresh_token": "ref-v2-none",
            "expires_at": "2026-06-01T13:00:00.000Z",
            "refresh_expires_at": "2026-07-01T00:00:00.000Z",
            "jti": "jti-v2-none"
        }));
        let r_persist2 = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/v2/persist")
                    .header(header::AUTHORIZATION, format!("Bearer {v2_jwt2}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_persist2.status(), StatusCode::OK);

        // v2/refresh: 404 when not found
        let v2_missing = sign_rs256(&json!({ "access_token": "a", "jti": "missing-jti" }));
        let r_404 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/v2/refresh")
                    .header(header::AUTHORIZATION, format!("Bearer {v2_missing}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_404.status(), StatusCode::NOT_FOUND);

        // v2/refresh: fresh token -> returns existing
        let r_fresh = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/v2/refresh")
                    .header(header::AUTHORIZATION, format!("Bearer {v2_jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_fresh.status(), StatusCode::OK);
        assert_eq!(json_body(r_fresh).await["refreshToken"], "ref-v2");

        // v2/refresh: expired -> fail, bad dates, then success
        let past_dt = bson::DateTime::from_chrono(fixed_now() - Duration::minutes(10));
        for (jti, rtok) in [
            ("j-fail", "ref-fail"),
            ("j-bd1", "ref-baddate"),
            ("j-bd2", "ref-baddate2"),
        ] {
            env.mongo.insert(
                "tokens",
                doc! { "tokenId": jti, "accessToken": "old", "refreshToken": rtok, "expiresAt": past_dt, "refreshExpiresAt": past_dt },
            );
            let tok = sign_rs256(&json!({ "access_token": "a", "jti": jti }));
            let r = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/auth/v2/refresh")
                        .header(header::AUTHORIZATION, format!("Bearer {tok}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        }

        env.mongo
            .update_one(
                "tokens",
                doc! { "tokenId": "jti-v2" },
                doc! { "$set": { "expiresAt": past_dt } },
                false,
            )
            .await
            .unwrap();
        let r_refreshed = app
            .oneshot(
                Request::builder()
                    .uri("/auth/v2/refresh")
                    .header(header::AUTHORIZATION, format!("Bearer {v2_jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_refreshed.status(), StatusCode::OK);
        assert_eq!(json_body(r_refreshed).await["accessToken"], "v2-fresh-acc");
    }

    #[tokio::test]
    async fn logout_and_state_endpoints_behave_like_node() {
        let env = setup_env(Arc::new(MockHttp::new(|_| unreachable!())), None);
        let app = router_for(&env.state);

        let r_logout = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/logout")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_logout.status(), StatusCode::FOUND);
        assert_eq!(
            r_logout.headers().get(header::LOCATION).unwrap(),
            "https://egdata.app/"
        );
        let set_cookie = r_logout
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set_cookie.contains("EGDATA_AUTH=;"));
        assert!(set_cookie.contains("Path=/"));
        assert!(set_cookie.contains("Domain=egdata.app"));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("Secure"));

        // Save state
        let r_save = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/v2/save-state")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_save.status(), StatusCode::OK);
        let code = json_body(r_save).await["state"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(code.len(), 32);
        assert!(
            code.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
        );
        assert_eq!(
            env.redis
                .store
                .lock()
                .unwrap()
                .get(&format!("state-code:{code}")),
            Some(&("true".to_string(), 3600))
        );

        // Validate state: invalid JSON / empty / unknown / valid
        for body in [r#"{}"#, r#"{"state":""}"#] {
            let r = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/auth/v2/validate-state")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::BAD_REQUEST);
            assert_eq!(json_body(r).await["error"], "Missing state parameter");
        }

        let r_invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/v2/validate-state")
                    .body(Body::from(r#"{"state":"UNKNOWN"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(r_invalid).await["error"], "Invalid state code");

        let r_valid = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/v2/validate-state")
                    .body(Body::from(json!({ "state": code }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_valid.status(), StatusCode::OK);
        assert_eq!(json_body(r_valid).await, json!({ "valid": true }));
    }

    async fn discord_callback_uri(app: &Router, code: &str) -> String {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/discord/link")
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let location = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let state = location
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1;
        format!("/auth/discord/callback?code={code}&state={state}")
    }

    #[tokio::test]
    async fn discord_link_and_callback_cover_oauth_donor_roles_and_errors() {
        let jwt = make_unsigned_jwt(&json!({ "sub": "acc-1", "appid": "app-1" }));
        let http = Arc::new(MockHttp::new(|req| {
            if req.url == EPIC_TOKEN_INFO_URL {
                return Ok(epic_token_info_ok("acc-1"));
            }
            if req.url == "https://discord.com/api/v10/oauth2/token" {
                let body = String::from_utf8_lossy(req.body.as_deref().unwrap_or(&[]));
                if body.contains("code=tok-err") {
                    return Err(CoreError::Upstream("net".into()));
                }
                if body.contains("code=tok-400") {
                    return Ok(UpstreamHttpResponse {
                        status: 400,
                        body: b"{}".to_vec(),
                    });
                }
                if body.contains("code=tok-badjson") {
                    return Ok(UpstreamHttpResponse {
                        status: 200,
                        body: b"bad".to_vec(),
                    });
                }
                let tok = if body.contains("code=user-err") {
                    "u-err"
                } else if body.contains("code=user-badjson") {
                    "u-badjson"
                } else if body.contains("code=rev-err") {
                    "r-err"
                } else {
                    "ok-tok"
                };
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({ "access_token": tok })).unwrap(),
                });
            }
            if req.url == "https://discord.com/api/v10/users/@me" {
                let auth = req
                    .headers
                    .get("authorization")
                    .map(String::as_str)
                    .unwrap_or("");
                if auth.contains("u-err") {
                    return Ok(UpstreamHttpResponse {
                        status: 401,
                        body: b"{}".to_vec(),
                    });
                }
                if auth.contains("u-badjson") {
                    return Ok(UpstreamHttpResponse {
                        status: 200,
                        body: b"bad".to_vec(),
                    });
                }
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: br#"{"id":"disc-99","username":"alice"}"#.to_vec(),
                });
            }
            if req.url == "https://discord.com/api/v10/oauth2/token/revoke" {
                let body = String::from_utf8_lossy(req.body.as_deref().unwrap_or(&[]));
                if body.contains("token=r-err") {
                    return Ok(UpstreamHttpResponse {
                        status: 400,
                        body: b"{}".to_vec(),
                    });
                }
                return Ok(UpstreamHttpResponse {
                    status: 200,
                    body: b"{}".to_vec(),
                });
            }
            unreachable!()
        }));

        let env = setup_env(http, Some(sample_session("acc-1@epic.egdata.app")));
        env.mongo.insert("epic", doc! { "accountId": "acc-1" });
        let app = router_for(&env.state);

        // /discord/link unauth -> 401
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/auth/discord/link")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        // /discord/link auth -> 302
        let r_link = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/discord/link")
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_link.status(), StatusCode::FOUND);
        let loc = r_link
            .headers()
            .get(header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(loc.starts_with("https://discord.com/oauth2/authorize?"));
        assert!(loc.contains("client_id=1270522540992888832"));
        assert!(loc.contains("&state="));
        for marker in env.redis.store.lock().unwrap().values() {
            assert_eq!(marker.1, 600);
        }

        // /discord/callback ?error=... -> redirect home
        let r_err = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/discord/callback?error=access_denied")
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_err.status(), StatusCode::FOUND);
        assert_eq!(
            r_err.headers().get(header::LOCATION).unwrap(),
            "https://egdata.app/"
        );

        // /discord/callback with EPIC_AUTH (no session) -> redirect home
        let r_no_sess = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/discord/callback?code=ok")
                    .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r_no_sess.headers().get(header::LOCATION).unwrap(),
            "https://egdata.app/"
        );

        // Token & user error redirects
        for (code, expected_loc) in [
            (
                "tok-err",
                "https://egdata.app/?error=discord-get-token-failed",
            ),
            (
                "tok-400",
                "https://egdata.app/?error=discord-get-token-failed",
            ),
            (
                "tok-badjson",
                "https://egdata.app/?error=discord-get-token-failed",
            ),
            (
                "user-err",
                "https://egdata.app/?error=discord-get-user-failed",
            ),
            (
                "user-badjson",
                "https://egdata.app/?error=discord-get-user-failed",
            ),
            (
                "rev-err",
                "https://egdata.app/?error=discord-revoke-token-failed",
            ),
        ] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(discord_callback_uri(&app, code).await)
                        .header(header::COOKIE, "better-auth.session_token=valid")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::FOUND);
            assert_eq!(resp.headers().get(header::LOCATION).unwrap(), expected_loc);
        }

        // Non-donor success -> no role call
        let callback_uri = discord_callback_uri(&app, "ok").await;
        let mut other_state = env.state.clone();
        let mut other_session = sample_session("acc-1@epic.egdata.app");
        other_session
            .claims
            .insert("sessionId".into(), json!("other-browser-session"));
        other_state.session_verifier = Arc::new(MockSessionVerifier(Some(other_session)));
        let before = env.mongo.all("epic");
        let rejected = router_for(&other_state)
            .oneshot(
                Request::builder()
                    .uri(&callback_uri)
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.headers()[header::LOCATION], "https://egdata.app/");
        assert_eq!(env.mongo.all("epic"), before);
        let r_non_donor = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&callback_uri)
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r_non_donor.headers().get(header::LOCATION).unwrap(),
            "https://egdata.app/discord-linked"
        );
        assert!(env.discord.calls.lock().unwrap().is_empty());
        assert_eq!(
            env.mongo.all("epic")[0].get_str("discordId").unwrap(),
            "disc-99"
        );

        // Consumed, missing, or expired states cannot authorize another link.
        for uri in [
            &callback_uri[..],
            "/auth/discord/callback?code=ok",
            "/auth/discord/callback?code=ok&state=00000000-0000-4000-8000-000000000000",
        ] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(header::COOKIE, "better-auth.session_token=valid")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.headers()[header::LOCATION], "https://egdata.app/");
        }

        // Donor success (even when discord.request returns Err, still succeeds)
        env.mongo.insert("key-codes", doc! { "accountId": "acc-1" });
        *env.discord.fail.lock().unwrap() = true;
        let callback_uri = discord_callback_uri(&app, "ok").await;
        let r_donor = app
            .oneshot(
                Request::builder()
                    .uri(callback_uri)
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r_donor.headers().get(header::LOCATION).unwrap(),
            "https://egdata.app/discord-linked"
        );
        assert_eq!(
            env.discord.calls.lock().unwrap().as_slice(),
            &[(
                "PUT".to_string(),
                "/guilds/561598657879605269/members/disc-99/roles/1379892703793512599".to_string()
            )]
        );
    }
}
