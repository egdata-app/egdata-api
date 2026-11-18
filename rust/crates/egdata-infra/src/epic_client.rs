//! Epic Store GraphQL client, storefront featured games, ownership check, and Discord OAuth user lookup.

use std::collections::HashMap;

use reqwest::Client;
use reqwest::header::{
    ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, HeaderMap, HeaderValue, ORIGIN, REFERER, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tracing::{error, warn};

pub const EPIC_STORE_GRAPHQL_URL: &str = "https://store.epicgames.com/graphql";
pub const EPIC_STORE_USER_AGENT: &str =
    "EpicGamesLauncher/18.8.0-44107768+++Portal+Release-Live Windows/10.0.26100.1.256.64bit";
pub const EPIC_STORE_ORIGIN: &str = "https://store.epicgames.com";
pub const EPIC_STORE_REFERER: &str = "https://store.epicgames.com/en-US/";
pub const EPIC_STORE_FRONT_URL: &str = "https://store-site-backend-static-ipv4.ak.epicgames.com/storefrontLayout?locale=en-US&country=ES&start=0&count=9";
const EPIC_TOKEN_INFO_URL: &str = "https://api.epicgames.dev/epic/oauth/v2/tokenInfo";
pub const DISCORD_OAUTH_ME_URL: &str = "https://discord.com/api/v10/oauth2/@me";

pub const PLAYER_PROFILE_QUERY: &str = r#"
query playerProfile($epicAccountId: String!) {
  PlayerProfile {
    playerProfile(epicAccountId: $epicAccountId) {
      epicAccountId
      displayName
      avatar {
        small
        medium
        large
      }
    }
  }
}
"#;

pub const PLAYER_PROFILE_ACHIEVEMENTS_BY_PRODUCT_ID_QUERY: &str = r#"
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

pub const PLAYER_PROFILE_PRIVATE_QUERY: &str = r#"
query playerProfilePrivate($epicAccountId: String!, $locale: String!) {
  PlayerProfile {
    playerProfile(epicAccountId: $epicAccountId) {
      privacy {
        accessLevel
      }
      relationship
      achievementsSummaries {
        __typename
        ... on PlayerAchievementResponseSuccess {
          status
          data {
            totalUnlocked
            totalXP
            sandboxId
            baseOfferForSandbox(locale: $locale) {
              id
              namespace
              keyImages {
                url
                type
                alt
                md5
              }
            }
            product(locale: $locale) {
              name
              slug
            }
            productAchievements {
              totalAchievements
              totalProductXP
            }
            playerAwards {
              awardType
            }
          }
        }
      }
    }
  }
  ContentControl {
    get {
      __typename
    }
  }
}
"#;

pub const GET_OFFERS_VALIDATION_QUERY: &str = r#"
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

/// Errors returned by Discord OAuth or storefront fetches.
#[derive(Debug, Error)]
pub enum EpicClientError {
    #[error("Failed to fetch Discord user: {0}")]
    DiscordHttp(u16),
    #[error("http error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("json decode error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Builds the exact default `EPIC_STORE_HEADERS` from `src/clients/epic.ts`.
pub fn epic_store_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(ORIGIN, HeaderValue::from_static(EPIC_STORE_ORIGIN));
    headers.insert(REFERER, HeaderValue::from_static(EPIC_STORE_REFERER));
    headers.insert(USER_AGENT, HeaderValue::from_static(EPIC_STORE_USER_AGENT));
    headers
}

/// Summary of a failed Epic GraphQL response (`summarizeEpicGraphQlError` in `src/clients/epic.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpicGraphQlErrorSummary {
    pub status: Option<u16>,
    pub cf_mitigated: Option<String>,
    pub cf_ray: Option<String>,
    pub content_type: Option<String>,
    pub cloudflare_challenge: bool,
    pub message: String,
}

/// Detects Cloudflare challenge responses identically to `isEpicGraphQlCloudflareChallenge` in `src/clients/epic.ts`.
pub fn is_epic_graphql_cloudflare_challenge(
    status: Option<u16>,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> bool {
    if status != Some(403) {
        return false;
    }
    if header_ci(headers, "cf-mitigated").as_deref() == Some("challenge") {
        return true;
    }
    if header_ci(headers, "server")
        .as_deref()
        .is_some_and(|s| s.eq_ignore_ascii_case("cloudflare"))
    {
        let body = body.unwrap_or("");
        return body.contains("cf_challenge_container")
            || body.contains("/cdn-cgi/challenge-platform/");
    }
    false
}

/// Builds an [`EpicGraphQlErrorSummary`] matching `summarizeEpicGraphQlError` in `src/clients/epic.ts`.
pub fn summarize_epic_graphql_error(
    operation: &str,
    status: Option<u16>,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> EpicGraphQlErrorSummary {
    let cf_mitigated = header_ci(headers, "cf-mitigated");
    let cf_ray = header_ci(headers, "cf-ray");
    let content_type = header_ci(headers, "content-type");
    let cloudflare_challenge = is_epic_graphql_cloudflare_challenge(status, headers, body);
    let message = if cloudflare_challenge {
        format!("Epic GraphQL {operation} was blocked by a Cloudflare challenge.")
    } else {
        format!("Epic GraphQL {operation} failed.")
    };
    EpicGraphQlErrorSummary {
        status,
        cf_mitigated,
        cf_ray,
        content_type,
        cloudflare_challenge,
        message,
    }
}

fn header_ci(headers: &HashMap<String, String>, name: &str) -> Option<String> {
    if let Some(exact) = headers.get(name) {
        return Some(exact.clone());
    }
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
}

fn header_map_to_hash_map(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_string(), s.to_string()))
        })
        .collect()
}

/// Offer reference for ownership checks (`src/clients/epic.ts` / `get-owned-offers.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfferToValidate {
    pub namespace: String,
    #[serde(rename = "offerId", alias = "id")]
    pub offer_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationErrorOffer {
    pub namespace: String,
    pub offer_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationErrorItem {
    pub namespace: String,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationOfferConflict {
    pub namespace: String,
    pub offer_id: String,
    pub conflicting_offers: Vec<ValidationErrorOffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationMissingPrereq {
    pub namespace: String,
    pub offer_id: String,
    pub missing_prerequisite_items: Vec<ValidationErrorItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartOffersValidation {
    pub conflicting_offers: Vec<ValidationOfferConflict>,
    pub missing_prerequisites: Vec<ValidationMissingPrereq>,
    pub fully_owned_offers: Vec<ValidationErrorOffer>,
    pub possible_partial_upgrade_offers: Vec<ValidationErrorOffer>,
    pub unable_partially_upgrade_offers: Vec<ValidationErrorOffer>,
}

/// Result of [`EpicStoreClient::check_ownership`] matching TS `cartOffersValidation | errors | null`.
#[derive(Debug, Clone, PartialEq)]
pub enum OwnershipCheckResult {
    Validation(CartOffersValidation),
    GraphQlErrors(Vec<Value>),
    Unavailable,
}

/// Epic Store GraphQL client (`src/clients/epic.ts`).
#[derive(Clone)]
pub struct EpicStoreClient {
    graphql_url: String,
    token_info_url: String,
    storefront_url: String,
    discord_me_url: String,
    http: Client,
}

impl Default for EpicStoreClient {
    fn default() -> Self {
        Self::new()
    }
}

impl EpicStoreClient {
    pub async fn token_info_account(&self, token: &str) -> Option<String> {
        let response = self
            .http
            .post(&self.token_info_url)
            .form(&[("token", token)])
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let info = response.json::<Value>().await.ok()?;
        if info["active"] != true {
            return None;
        }
        info["account_id"]
            .as_str()
            .filter(|account| !account.is_empty())
            .map(str::to_owned)
    }
    pub fn new() -> Self {
        Self {
            graphql_url: EPIC_STORE_GRAPHQL_URL.to_string(),
            token_info_url: EPIC_TOKEN_INFO_URL.into(),
            storefront_url: EPIC_STORE_FRONT_URL.to_string(),
            discord_me_url: DISCORD_OAUTH_ME_URL.to_string(),
            http: Client::new(),
        }
    }

    pub fn with_urls(
        graphql_url: impl Into<String>,
        storefront_url: impl Into<String>,
        discord_me_url: impl Into<String>,
        http: Client,
    ) -> Self {
        Self {
            graphql_url: graphql_url.into(),
            token_info_url: EPIC_TOKEN_INFO_URL.into(),
            storefront_url: storefront_url.into(),
            discord_me_url: discord_me_url.into(),
            http,
        }
    }

    pub async fn graphql_raw(
        &self,
        query: &str,
        variables: &Value,
    ) -> Result<Value, EpicClientError> {
        let resp = self
            .http
            .post(&self.graphql_url)
            .headers(epic_store_headers())
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await?;
        let text = resp.text().await?;
        Ok(serde_json::from_str(&text)?)
    }

    async fn graphql_request(
        &self,
        operation: &str,
        query: &str,
        variables: Value,
        auth_token: Option<&str>,
    ) -> Option<Value> {
        let mut headers = epic_store_headers();
        if let Some(token) = auth_token {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}")).ok()?,
            );
        }

        let resp = match self
            .http
            .post(&self.graphql_url)
            .headers(headers)
            .json(&json!({ "query": query, "variables": variables, "operationName": operation }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                let summary = summarize_epic_graphql_error(operation, None, &HashMap::new(), None);
                error!(operation, status = ?summary.status, "{}", summary.message);
                return None;
            }
        };

        let status = resp.status();
        let resp_headers = header_map_to_hash_map(resp.headers());
        let body_text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            let summary = summarize_epic_graphql_error(
                operation,
                Some(status.as_u16()),
                &resp_headers,
                Some(&body_text),
            );
            if summary.cloudflare_challenge {
                warn!(
                    operation,
                    status = ?summary.status,
                    cf_mitigated = ?summary.cf_mitigated,
                    cf_ray = ?summary.cf_ray,
                    content_type = ?summary.content_type,
                    "{}",
                    summary.message
                );
            } else {
                error!(
                    operation,
                    status = ?summary.status,
                    cf_mitigated = ?summary.cf_mitigated,
                    cf_ray = ?summary.cf_ray,
                    content_type = ?summary.content_type,
                    "{}",
                    summary.message
                );
            }
            if auth_token.is_some()
                && let Ok(mut parsed) = serde_json::from_str::<Value>(&body_text)
                && let Some(errors) = parsed.get_mut("errors")
            {
                return Some(json!({"errors":errors.take()}));
            }
            return None;
        }

        match serde_json::from_str::<Value>(&body_text) {
            Ok(parsed) => Some(parsed),
            Err(_) => {
                let summary = summarize_epic_graphql_error(
                    operation,
                    Some(status.as_u16()),
                    &resp_headers,
                    Some(&body_text),
                );
                error!(operation, status = ?summary.status, "{}", summary.message);
                None
            }
        }
    }

    pub async fn get_user(&self, account_id: &str) -> Option<Value> {
        let res = self
            .graphql_request(
                "playerProfile",
                PLAYER_PROFILE_QUERY,
                json!({ "epicAccountId": account_id }),
                None,
            )
            .await?;
        res.pointer("/data/PlayerProfile/playerProfile")
            .filter(|v| !v.is_null())
            .cloned()
    }

    pub async fn get_user_product_achievements(
        &self,
        account_id: &str,
        product_id: &str,
    ) -> Option<Value> {
        let res = self
            .graphql_request(
                "playerProfileAchievementsByProductId",
                PLAYER_PROFILE_ACHIEVEMENTS_BY_PRODUCT_ID_QUERY,
                json!({ "epicAccountId": account_id, "productId": product_id }),
                None,
            )
            .await?;
        res.pointer("/data/PlayerProfile/playerProfile/productAchievements")
            .filter(|v| !v.is_null())
            .cloned()
    }

    pub async fn get_user_achievements(&self, account_id: &str) -> Option<Value> {
        let res = self
            .graphql_request(
                "playerProfilePrivate",
                PLAYER_PROFILE_PRIVATE_QUERY,
                json!({ "epicAccountId": account_id, "locale": "en-US" }),
                None,
            )
            .await?;
        res.pointer("/data/PlayerProfile/playerProfile/achievementsSummaries")
            .filter(|v| !v.is_null())
            .cloned()
    }

    pub async fn check_ownership(
        &self,
        offers: &[OfferToValidate],
        auth_token: &str,
    ) -> OwnershipCheckResult {
        let Some(res) = self
            .graphql_request(
                "getOffersValidation",
                GET_OFFERS_VALIDATION_QUERY,
                json!({ "offers": offers }),
                Some(auth_token),
            )
            .await
        else {
            return OwnershipCheckResult::Unavailable;
        };

        // graphql-request uses its default error policy for authenticated ownership checks.
        if let Some(errors) = res.get("errors").and_then(Value::as_array)
            && !errors.is_empty()
        {
            return OwnershipCheckResult::GraphQlErrors(errors.clone());
        }

        if let Some(val) = res
            .get("data")
            .and_then(|d| d.get("Entitlements"))
            .and_then(|e| e.get("cartOffersValidation"))
            .filter(|v| !v.is_null())
            && let Ok(parsed) = serde_json::from_value::<CartOffersValidation>(val.clone())
        {
            return OwnershipCheckResult::Validation(parsed);
        }

        if let Some(errors) = res.get("errors").and_then(Value::as_array) {
            return OwnershipCheckResult::GraphQlErrors(errors.clone());
        }

        OwnershipCheckResult::Unavailable
    }

    /// Ports `verifyGameOwnership` (`src/utils/verify-game-ownership.ts`).
    pub async fn verify_game_ownership(&self, account_id: &str, product_id: &str) -> bool {
        if self.get_user(account_id).await.is_none() {
            return false;
        }
        let Some(achievements) = self
            .get_user_product_achievements(account_id, product_id)
            .await
        else {
            return false;
        };
        if achievements.get("__typename").and_then(Value::as_str) == Some("ServiceError") {
            return false;
        }
        let list_len = achievements
            .get("data")
            .and_then(|d| d.get("playerAchievements"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        list_len > 0
    }

    /// Ports `getFeaturedGames` (`src/utils/get-featured-games.ts`).
    pub async fn get_featured_games(&self) -> Result<Vec<FeaturedOfferRef>, EpicClientError> {
        Ok(self
            .featured_offer_documents()
            .await?
            .into_iter()
            .filter_map(|offer| serde_json::from_value(offer).ok())
            .collect())
    }

    pub(crate) async fn featured_offer_documents(&self) -> Result<Vec<Value>, EpicClientError> {
        let resp = self.http.get(&self.storefront_url).send().await?;
        let mut root: Value = resp.json().await?;
        let invalid = || {
            serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid storefront carousel",
            ))
        };
        let modules = root
            .pointer_mut("/data/Storefront/storefrontModulesPaginated/modules")
            .and_then(Value::as_array_mut)
            .ok_or_else(invalid)?;
        let slides = modules
            .iter_mut()
            .find(|module| {
                module.get("id").and_then(Value::as_str) == Some("new-carousel-definitive")
            })
            .and_then(|module| module.get_mut("slides"))
            .and_then(Value::as_array_mut)
            .ok_or_else(invalid)?;
        slides
            .iter_mut()
            .map(|slide| {
                slide
                    .get_mut("offer")
                    .filter(|offer| !offer.is_null())
                    .map(Value::take)
                    .ok_or_else(|| EpicClientError::Json(invalid()))
            })
            .collect()
    }

    /// Ports `getDiscordUser` (`src/utils/get-discord-user.ts`).
    pub async fn get_discord_user(
        &self,
        token: &str,
    ) -> Result<Option<DiscordOAuthUser>, EpicClientError> {
        let resp = self
            .http
            .get(&self.discord_me_url)
            .bearer_auth(token)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(EpicClientError::DiscordHttp(resp.status().as_u16()));
        }
        let body: DiscordMeResponse = resp.json().await?;
        Ok(body.user)
    }
}

/// Featured game offer identifier (`src/utils/get-featured-games.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeaturedOfferRef {
    pub namespace: String,
    pub id: String,
}

/// Discord OAuth user (`src/utils/get-discord-user.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscordOAuthUser {
    pub id: String,
    pub email: Option<String>,
    pub username: Option<String>,
    pub avatar: Option<String>,
    pub discriminator: Option<String>,
    pub public_flags: Option<u64>,
    pub flags: Option<u64>,
    pub banner: Option<Value>,
    pub accent_color: Option<u64>,
    pub global_name: Option<String>,
    pub avatar_decoration_data: Option<Value>,
    pub banner_color: Option<String>,
    pub clan: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct DiscordMeResponse {
    user: Option<DiscordOAuthUser>,
}

#[cfg(test)]
#[path = "epic_client_oracle.rs"]
mod oracle;

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_core::ports::EpicStorePort;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    async fn spawn_mock_server<F>(count: usize, handler: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(String, String) -> (u16, Vec<(&'static str, &'static str)>, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            for _ in 0..count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let req = oracle::read_request(&mut socket).await;
                let (status, extra_headers, body) = handler(req.path, req.body);
                let mut response = format!(
                    "HTTP/1.1 {status} Status\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (key, value) in extra_headers {
                    response.push_str(&format!("{key}: {value}\r\n"));
                }
                response.push_str("\r\n");
                response.push_str(&body);
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{addr}"), task)
    }

    #[tokio::test]
    async fn verifies_active_epic_tokens_with_token_info() {
        let (server, task) = spawn_mock_server(7, |path, body| {
            assert_eq!(path, "/tokenInfo");
            if body == "token=broken" {
                return (200, vec![], "unfinished".into());
            }
            let (status, response) = match body.as_str() {
                "token=fixture%2Bactive" => (
                    200,
                    json!({"active":true,"account_id":"fixture-remote-account"}),
                ),
                "token=inactive" => (
                    200,
                    json!({"active":false,"account_id":"fixture-remote-account"}),
                ),
                "token=missing" => (200, json!({"active":true})),
                "token=proxy" => (
                    600,
                    json!({"active":true,"account_id":"fixture-remote-account"}),
                ),
                "token=empty" => (200, json!({"active":true,"account_id":""})),
                _ => (401, json!({"error":"invalid_token"})),
            };
            (status, vec![], response.to_string())
        })
        .await;
        let client = EpicStoreClient {
            token_info_url: format!("{server}/tokenInfo"),
            ..Default::default()
        };
        assert_eq!(
            client
                .token_account("fixture+active")
                .await
                .unwrap()
                .as_deref(),
            Some("fixture-remote-account")
        );
        for token in ["inactive", "missing", "invalid", "broken", "proxy", "empty"] {
            assert_eq!(client.token_account(token).await.unwrap(), None);
        }
        task.await.unwrap();
        assert!(client.token_info_account("offline").await.is_none());
    }

    #[test]
    fn headers_and_cloudflare_challenge_detection() {
        let headers = epic_store_headers();
        assert_eq!(headers.get(USER_AGENT).unwrap(), EPIC_STORE_USER_AGENT);
        assert_eq!(headers.get(ORIGIN).unwrap(), EPIC_STORE_ORIGIN);

        let mut h = HashMap::new();
        assert!(!is_epic_graphql_cloudflare_challenge(Some(500), &h, None));

        h.insert("CF-Mitigated".into(), "challenge".into());
        assert!(is_epic_graphql_cloudflare_challenge(Some(403), &h, None));

        let mut h2 = HashMap::new();
        h2.insert("Server".into(), "cloudflare".into());
        h2.insert("CF-Ray".into(), "ray-123".into());
        h2.insert("Content-Type".into(), "text/html".into());
        let summary = summarize_epic_graphql_error(
            "playerProfile",
            Some(403),
            &h2,
            Some("<html><div id=\"cf_challenge_container\"></div></html>"),
        );
        assert!(summary.cloudflare_challenge);
        assert_eq!(summary.cf_ray.as_deref(), Some("ray-123"));
        assert!(summary.message.contains("Cloudflare challenge"));

        let summary_plain =
            summarize_epic_graphql_error("playerProfile", Some(502), &HashMap::new(), None);
        assert!(!summary_plain.cloudflare_challenge);
        assert_eq!(summary_plain.message, "Epic GraphQL playerProfile failed.");

        let mut h3 = HashMap::new();
        h3.insert("server".into(), "cloudflare".into());
        assert!(is_epic_graphql_cloudflare_challenge(
            Some(403),
            &h3,
            Some("<script src=\"/cdn-cgi/challenge-platform/h/b\"></script>")
        ));
        assert!(!is_epic_graphql_cloudflare_challenge(
            Some(403),
            &HashMap::new(),
            Some("denied")
        ));
    }

    #[tokio::test]
    async fn epic_graphql_ownership_featured_and_discord() {
        let (base, task) = spawn_mock_server(24, |path, body| {
            if path == "/graphql" {
                if body.contains("cf-block") {
                    return (
                        403,
                        vec![("cf-mitigated", "challenge"), ("cf-ray", "abc")],
                        "blocked".into(),
                    );
                }
                if body.contains("server-err") {
                    return (500, vec![], "internal".into());
                }
                if body.contains("bad-json") {
                    return (200, vec![], "not json".into());
                }
                if body.contains("playerProfileAchievementsByProductId") {
                    if body.contains("service-err") {
                        return (
                            200,
                            vec![("content-type", "application/json")],
                            r#"{"data":{"PlayerProfile":{"playerProfile":{"productAchievements":{"__typename":"ServiceError"}}}}}"#.into(),
                        );
                    }
                    return (
                        200,
                        vec![("content-type", "application/json")],
                        r#"{"data":{"PlayerProfile":{"playerProfile":{"productAchievements":{"__typename":"PlayerProductAchievementsResponseSuccess","data":{"playerAchievements":[{"playerAchievement":{"achievementName":"A1","unlocked":true}}]}}}}}}"#.into(),
                    );
                }
                if body.contains("playerProfilePrivate") {
                    return (
                        200,
                        vec![],
                        r#"{"data":{"PlayerProfile":{"playerProfile":{"achievementsSummaries":[{"__typename":"PlayerAchievementResponseSuccess"}]}}}}"#.into(),
                    );
                }
                if body.contains("playerProfile") {
                    if body.contains("missing-user") {
                        return (200, vec![], r#"{"data":{"PlayerProfile":{"playerProfile":null}}}"#.into());
                    }
                    return (
                        200,
                        vec![],
                        r#"{"data":{"PlayerProfile":{"playerProfile":{"epicAccountId":"acc1","displayName":"Player"}}}}"#.into(),
                    );
                }
                assert!(body.contains("getOffersValidation"));
                if body.contains("gql-err") {
                    return (401, vec![], r#"{"errors":[{"message":"unauthorized"}]}"#.into());
                }
                if body.contains("null-val") {
                    return (200, vec![], r#"{"data":{"Entitlements":{"cartOffersValidation":null}}}"#.into());
                }
                (
                    200,
                    vec![],
                    r#"{"data":{"Entitlements":{"cartOffersValidation":{"conflictingOffers":[],"missingPrerequisites":[],"fullyOwnedOffers":[{"namespace":"ns1","offerId":"of1"}],"possiblePartialUpgradeOffers":[],"unablePartiallyUpgradeOffers":[]}}}}"#.into(),
                )
            } else if path == "/storefront" {
                (
                    200,
                    vec![],
                    r#"{"data":{"Storefront":{"storefrontModulesPaginated":{"modules":[{"id":"other"},{"id":"new-carousel-definitive","slides":[{"offer":{"namespace":"fn","id":"123"}}]}]}}}}"#.into(),
                )
            } else if path == "/storefront-bad" {
                (200, vec![], r#"{"data":{}}"#.into())
            } else if path == "/discord-ok" {
                (200, vec![], r#"{"user":{"id":"d1","username":"u1"}}"#.into())
            } else if path == "/discord-empty" {
                (200, vec![], r#"{}"#.into())
            } else {
                assert_eq!(path, "/discord-err");
                (401, vec![], r#"{"message":"401: Unauthorized"}"#.into())
            }
        })
        .await;

        let default_client = EpicStoreClient::default();
        assert_eq!(default_client.graphql_url, EPIC_STORE_GRAPHQL_URL);

        let client = EpicStoreClient::with_urls(
            format!("{base}/graphql"),
            format!("{base}/storefront"),
            format!("{base}/discord-ok"),
            Client::new(),
        );

        assert_eq!(
            client.get_user("acc1").await.unwrap()["displayName"],
            "Player"
        );
        assert!(client.get_user("cf-block").await.is_none());
        assert!(client.get_user("server-err").await.is_none());
        assert!(client.get_user("bad-json").await.is_none());
        assert!(client.get_user("missing-user").await.is_none());

        assert!(client.get_user_achievements("acc1").await.is_some());
        assert!(client.verify_game_ownership("acc1", "prod1").await);
        assert!(!client.verify_game_ownership("missing-user", "prod1").await);
        assert!(!client.verify_game_ownership("acc1", "service-err").await);
        assert!(!client.verify_game_ownership("acc1", "cf-block").await);

        let own_ok = client
            .check_ownership(
                &[OfferToValidate {
                    namespace: "ns1".into(),
                    offer_id: "of1".into(),
                }],
                "tok",
            )
            .await;
        assert!(
            matches!(own_ok, OwnershipCheckResult::Validation(v) if v.fully_owned_offers.len() == 1)
        );

        let own_err = client
            .check_ownership(
                &[OfferToValidate {
                    namespace: "ns1".into(),
                    offer_id: "gql-err".into(),
                }],
                "tok",
            )
            .await;
        assert!(matches!(own_err, OwnershipCheckResult::GraphQlErrors(errs) if errs.len() == 1));

        let own_unavail = client
            .check_ownership(
                &[OfferToValidate {
                    namespace: "ns1".into(),
                    offer_id: "server-err".into(),
                }],
                "tok",
            )
            .await;
        assert_eq!(own_unavail, OwnershipCheckResult::Unavailable);

        let own_null = client
            .check_ownership(
                &[OfferToValidate {
                    namespace: "ns1".into(),
                    offer_id: "null-val".into(),
                }],
                "tok",
            )
            .await;
        assert_eq!(own_null, OwnershipCheckResult::Unavailable);

        let bad_sf = EpicStoreClient::with_urls(
            format!("{base}/graphql"),
            format!("{base}/storefront-bad"),
            format!("{base}/discord-ok"),
            Client::new(),
        );
        assert!(bad_sf.get_featured_games().await.is_err());

        let featured = client.get_featured_games().await.unwrap();
        assert_eq!(
            featured,
            vec![FeaturedOfferRef {
                namespace: "fn".into(),
                id: "123".into()
            }]
        );
        assert_eq!(
            EpicStorePort::featured_games(&client).await.unwrap(),
            vec![serde_json::json!({"namespace":"fn","id":"123"})]
        );

        let duser = client.get_discord_user("tok").await.unwrap().unwrap();
        assert_eq!(duser.id, "d1");

        let empty_discord = EpicStoreClient::with_urls(
            format!("{base}/graphql"),
            format!("{base}/storefront"),
            format!("{base}/discord-empty"),
            Client::new(),
        );
        assert!(
            empty_discord
                .get_discord_user("tok")
                .await
                .unwrap()
                .is_none()
        );

        let err_discord = EpicStoreClient::with_urls(
            format!("{base}/graphql"),
            format!("{base}/storefront"),
            format!("{base}/discord-err"),
            Client::new(),
        );
        assert_eq!(
            err_discord
                .get_discord_user("tok")
                .await
                .unwrap_err()
                .to_string(),
            "Failed to fetch Discord user: 401"
        );
        assert!(client.graphql_raw("bad-json", &json!({})).await.is_err());
        task.await.unwrap();

        // Transport failure
        let dead = EpicStoreClient::with_urls(
            "http://127.0.0.1:1/graphql",
            "http://127.0.0.1:1/storefront",
            "http://127.0.0.1:1/discord",
            Client::new(),
        );
        assert!(dead.get_user("acc1").await.is_none());
    }
}
