//! Bearer JWT authentication middleware (`src/middlewares/jwt.ts`, `src/utils/jwt.ts`).

use std::collections::BTreeMap;

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::state::{ApiConfig, AppState};

/// Verified JWT payload inserted into request extensions on successful authentication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerifiedJwtUser(pub BTreeMap<String, Value>);

impl VerifiedJwtUser {
    /// Returns a claim by key.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// Returns the `sub` string claim if present.
    pub fn subject(&self) -> Option<&str> {
        self.0.get("sub").and_then(Value::as_str)
    }
}

/// Verifies a HS256 JWT against `jwt_secret`.
pub fn verify_jwt(token: &str, jwt_secret: &str) -> Option<VerifiedJwtUser> {
    if jwt_secret.is_empty() || token.is_empty() {
        return None;
    }
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    decode::<BTreeMap<String, Value>>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &validation,
    )
    .ok()
    .map(|data| VerifiedJwtUser(data.claims))
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// Core JWT middleware parameterized by [`ApiConfig`].
pub async fn jwt_with_config(config: &ApiConfig, mut req: Request<Body>, next: Next) -> Response {
    let Some(auth_header) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return unauthorized_response();
    };

    if !auth_header.starts_with("Bearer ") {
        return unauthorized_response();
    }

    let token = auth_header.split(' ').nth(1).unwrap_or("");
    let Some(user) = verify_jwt(token, &config.jwt_secret) else {
        return unauthorized_response();
    };

    req.extensions_mut().insert(user);
    next.run(req).await
}

/// Axum middleware verifying Bearer JWT tokens using `state.config.jwt_secret`.
pub async fn jwt_middleware(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    jwt_with_config(&state.config, req, next).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::test_support::test_app_state;
    use axum::{Extension, Router, middleware, routing::get};
    use http_body_util::BodyExt;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use tower::ServiceExt;

    async fn whoami(Extension(user): Extension<VerifiedJwtUser>) -> Json<Value> {
        Json(json!({
            "sub": user.subject(),
            "role": user.get("role"),
        }))
    }

    fn sign_token(claims: &BTreeMap<String, Value>, secret: &str) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn verifies_bearer_jwt_and_rejects_invalid_requests() {
        let state = test_app_state(ApiConfig {
            jwt_secret: "super-secret-jwt-key".into(),
            ..Default::default()
        });
        let app = Router::new()
            .route("/me", get(whoami))
            .layer(middleware::from_fn_with_state(state, jwt_middleware));

        // Missing header
        let r1 = app
            .clone()
            .oneshot(Request::builder().uri("/me").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::UNAUTHORIZED);
        let b1: Value =
            serde_json::from_slice(&r1.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(b1, json!({ "error": "Unauthorized" }));

        // Non-Bearer scheme
        let r2 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/me")
                    .header(header::AUTHORIZATION, "Basic abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r2.status(), StatusCode::UNAUTHORIZED);

        // Invalid token
        let r3 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/me")
                    .header(header::AUTHORIZATION, "Bearer invalid.jwt.token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r3.status(), StatusCode::UNAUTHORIZED);

        // Expired token
        let mut expired_claims = BTreeMap::new();
        expired_claims.insert("sub".into(), json!("user-1"));
        expired_claims.insert("exp".into(), json!(1000));
        let expired = sign_token(&expired_claims, "super-secret-jwt-key");
        let r4 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/me")
                    .header(header::AUTHORIZATION, format!("Bearer {expired}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r4.status(), StatusCode::UNAUTHORIZED);

        // Valid token (without exp)
        let mut claims = BTreeMap::new();
        claims.insert("sub".into(), json!("user-42"));
        claims.insert("role".into(), json!("admin"));
        let valid = sign_token(&claims, "super-secret-jwt-key");
        let r5 = app
            .oneshot(
                Request::builder()
                    .uri("/me")
                    .header(header::AUTHORIZATION, format!("Bearer {valid}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r5.status(), StatusCode::OK);
        let b5: Value =
            serde_json::from_slice(&r5.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(b5, json!({ "sub": "user-42", "role": "admin" }));

        // Empty secret rejects even valid signature
        assert!(verify_jwt(&valid, "").is_none());
        assert!(verify_jwt("", "super-secret-jwt-key").is_none());
    }
}
