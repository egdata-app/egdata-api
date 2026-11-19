use super::*;

fn reply(value: Value) -> std::result::Result<UpstreamHttpResponse, CoreError> {
    Ok(UpstreamHttpResponse {
        status: 200,
        body: serde_json::to_vec(&value).unwrap(),
    })
}

async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let resp = router_for(state)
        .oneshot(
            builder
                .body(body.map(|v| Body::from(v.to_string())).unwrap_or_default())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap())),
    )
}

#[test]
fn token_parser_and_timestamp_readers_handle_malformed_input() {
    let p = URL_SAFE_NO_PAD.encode(b"{}");
    for value in [
        p.clone(),
        format!("{p}.{p}"),
        format!("{p}.{p}.sig.extra"),
        format!("%.{p}.sig"),
        format!("{}.{}.sig", URL_SAFE_NO_PAD.encode(b"["), p),
        format!("{}.{}.sig", URL_SAFE_NO_PAD.encode(b"[]"), p),
        format!("{p}.%.sig"),
    ] {
        assert!(decode_jwt_payload(&value).is_none());
    }
    assert!(parse_bson_datetime(&Bson::Int32(0)).is_none());
}

#[tokio::test]
async fn oidc_verifier_rejects_missing_signer_information_and_provider_outages() {
    let (key, _, jwk) = crate::account_admin::tests::rsa_keypair_pem();
    let private = EncodingKey::from_rsa_pem(key.as_bytes()).unwrap();
    let validation = Validation::new(Algorithm::RS256);
    let signed = |algorithm, key: &EncodingKey, kid: Option<&str>| {
        let mut head = Header::new(algorithm);
        head.kid = kid.map(str::to_owned);
        encode(&head, &json!({"exp":0}), key).unwrap()
    };
    let rs = signed(Algorithm::RS256, &private, Some("kid-1"));
    let hs = signed(
        Algorithm::HS256,
        &EncodingKey::from_secret(b"fixture-secret").unwrap(),
        Some("kid-1"),
    );
    let no_kid = signed(Algorithm::RS256, &private, None);
    let unknown = json!({"keys":[]}).to_string();
    let incomplete = json!({"keys":[{"kid":"kid-1"}]}).to_string();
    let bad_encoding = json!({"keys":[{"kty":"RSA","kid":"kid-1","e":"AQAB","n":"%"}]}).to_string();
    let expired = json!({"keys":[jwk]}).to_string();
    for (name, token, body, status) in [
        ("malformed token", "not-a-token", None, 200),
        ("unsupported algorithm", hs.as_str(), None, 200),
        ("missing key ID", no_kid.as_str(), None, 200),
        ("network failure", &rs, None, 200),
        ("unavailable endpoint", &rs, Some("{}"), 503),
        ("invalid JSON", &rs, Some("["), 200),
        ("unknown key", &rs, Some(unknown.as_str()), 200),
        ("incomplete key", &rs, Some(incomplete.as_str()), 200),
        ("invalid encoding", &rs, Some(bad_encoding.as_str()), 200),
        ("expired claims", &rs, Some(expired.as_str()), 200),
    ] {
        let body = body.map(str::to_owned);
        let env = setup_env(
            Arc::new(MockHttp::new(move |_| match &body {
                Some(raw) => Ok(UpstreamHttpResponse {
                    status,
                    body: raw.as_bytes().to_vec(),
                }),
                None => Err(CoreError::Upstream("fixture provider unavailable".into())),
            })),
            None,
        );
        assert!(
            verify_provider_jwt(
                &env.state,
                token,
                "https://fixture.invalid/jwks",
                &validation
            )
            .await
            .is_err(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn local_refresh_grants_survive_retryable_failures() {
    for failure in [
        "no client",
        "no secret",
        "expiry",
        "refresh expiry",
        "store",
    ] {
        let mut env = setup_env(
            Arc::new(MockHttp::new(move |_| {
                reply(json!({
                    "access_token":"fixture-new","refresh_token":"fixture-new-refresh",
                    "expires_at":if failure=="expiry"{"invalid"}else{"2026-06-02T12:00:00Z"},
                    "refresh_expires_at":if failure=="refresh expiry"{"invalid"}else{"2026-07-02T12:00:00Z"}
                }))
            })),
            None,
        );
        let cfg = Arc::make_mut(&mut env.state.config);
        if failure == "no client" {
            cfg.epic_client_id = None;
        }
        if failure == "no secret" {
            cfg.epic_client_secret = None;
        }
        env.mongo.insert(
            "tokens",
            doc! {"tokenId":"owned","refreshToken":"fixture-refresh"},
        );
        if failure == "store" {
            env.mongo.fail_on("tokens", "update_one", 1);
        }
        assert!(
            matches!(
                refresh_single_token(&env.state, "owned", "fixture-refresh").await,
                Err(RefreshFailure::Retry)
            ),
            "{failure}"
        );
        assert!(
            env.mongo.collections.lock().unwrap()["tokens"]
                .iter()
                .any(|doc| doc.get_str("refreshToken") == Ok("fixture-refresh"))
        );
    }
}

#[tokio::test]
async fn admin_rotation_and_discord_state_report_backend_failures() {
    for fault in ["list", "expired delete", "invalid grant delete"] {
        let env = setup_env(
            Arc::new(MockHttp::new(|_| {
                Ok(UpstreamHttpResponse {
                    status: 400,
                    body: br#"{"error":"invalid_grant"}"#.to_vec(),
                })
            })),
            None,
        );
        env.mongo.insert("tokens",doc!{"tokenId":"owned","refreshToken":"fixture-local","expiresAt":bson::DateTime::from_millis(0),
            "refreshExpiresAt":bson::DateTime::from_chrono(if fault=="expired delete"{fixed_now()-Duration::days(1)}else{fixed_now()+Duration::days(1)})});
        env.mongo.fail_on(
            "tokens",
            if fault == "list" {
                "find_many"
            } else {
                "delete_one"
            },
            1,
        );
        let (status, body) = request(
            &env.state,
            "PATCH",
            "/auth/refresh",
            Some("super-secret"),
            None,
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("Internal Server Error")
            ),
            "{fault}"
        );
    }
    let env = setup_env(
        Arc::new(MockHttp::new(|_| reply(json!({})))),
        Some(sample_session("fixture@fixture.invalid")),
    );
    env.redis
        .fail
        .store(true, std::sync::atomic::Ordering::Relaxed);
    for (method, path) in [
        ("POST", "/auth/v2/save-state"),
        ("GET", "/auth/discord/link"),
        (
            "GET",
            "/auth/discord/callback?code=local&state=00000000-0000-4000-8000-000000000011",
        ),
    ] {
        let response = router_for(&env.state)
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("cookie", "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "{path}"
        );
    }
}

#[tokio::test]
async fn rotation_reports_storage_failures_without_returning_stale_tokens() {
    for route in ["launcher", "legacy", "signed"] {
        let expected = if route == "signed" {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        let cases = if route == "launcher" {
            vec![("find_one", 1), ("update_one", 1)]
        } else {
            vec![
                ("find_one", 1),
                ("update_one", 1),
                ("find_one", 2),
                ("revoked", 1),
            ]
        };
        for (operation, occurrence) in cases {
            let mongo = Arc::new(MockMongo::default());
            let records = Arc::clone(&mongo);
            let mut env = setup_env(
                Arc::new(MockHttp::new(move |req| {
                    if req.url == EPIC_TOKEN_INFO_URL {
                        return Ok(epic_token_info_ok("fixture-owner"));
                    }
                    if operation == "revoked" {
                        records.collections.lock().unwrap().remove("tokens");
                    }
                    reply(
                        json!({"access_token":"new-access","refresh_token":"new-refresh",
                    "expires_at":"2026-06-02T12:00:00Z","refresh_expires_at":"2026-07-02T12:00:00Z"}),
                    )
                })),
                None,
            );
            env.state.mongo = mongo.clone();
            let id = ObjectId::new();
            let access = sign_rs256(
                &json!({"sub":"fixture-owner","iss":"https://api.epicgames.dev/epic/oauth/v2","aud":"epic-client-id","exp":fixed_now().timestamp()+3600}),
            );
            let wrapped = sign_rs256(&json!({"access_token":&access,"jti":"owned"}));
            mongo.insert("tokens", doc! {"_id":id,"accountId":"fixture-owner","tokenId":"owned","accessToken":&access,"refreshToken":"old-refresh","expiresAt":bson::DateTime::from_millis(0)});
            mongo.insert("launcher", doc! {"account_id":"admin-acc","refresh_token":"old-refresh","expires_at":bson::DateTime::from_millis(0)});
            let (collection, method, path, token) = match route {
                "launcher" => (
                    "launcher",
                    "PATCH",
                    "/auth/refresh-admin".to_owned(),
                    "super-secret",
                ),
                "signed" => (
                    "tokens",
                    "GET",
                    "/auth/v2/refresh".to_owned(),
                    wrapped.as_str(),
                ),
                _ => (
                    "tokens",
                    "GET",
                    format!("/auth/refresh?id={id}"),
                    access.as_str(),
                ),
            };
            let expected = if operation == "revoked" {
                StatusCode::NOT_FOUND
            } else {
                mongo.fail_on(collection, operation, occurrence);
                expected
            };
            let (status, body) = request(&env.state, method, &path, Some(token), None).await;
            assert_eq!(status, expected, "{route} {operation} {occurrence}: {body}");
            assert!(body.get("accessToken").is_none());
            assert!(body.get("refreshToken").is_none());
        }
    }
}

#[tokio::test]
async fn linked_discord_callback_reports_local_write_and_entitlement_failures() {
    for fault in ["profile", "entitlement", "none"] {
        let http = Arc::new(MockHttp::new(|req| match req.url.as_str() {
            "https://discord.com/api/v10/oauth2/token" => {
                reply(json!({"access_token":"fixture-access"}))
            }
            "https://discord.com/api/v10/users/@me" => {
                reply(json!({"id":"fixture-discord","username":"fixture"}))
            }
            _ => {
                assert_eq!(req.url, "https://discord.com/api/v10/oauth2/token/revoke");
                reply(json!({}))
            }
        }));
        let env = setup_env(http, Some(sample_session("fixture-owner@fixture.invalid")));
        env.mongo.insert("epic", doc! {"accountId":"fixture-owner"});
        env.mongo
            .insert("key-codes", doc! {"accountId":"fixture-owner"});
        match fault {
            "profile" => env.mongo.fail_on("epic", "update_one", 1),
            "entitlement" => env.mongo.fail_on("key-codes", "find_one", 1),
            _ => (),
        }
        let app = router_for(&env.state);
        let callback = discord_callback_uri(&app, "local-code").await;
        let response = app
            .oneshot(
                Request::builder()
                    .uri(callback)
                    .header(header::COOKIE, "better-auth.session_token=valid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        if fault == "none" {
            assert_eq!(
                response.headers()[header::LOCATION],
                "https://egdata.app/discord-linked"
            );
            assert_eq!(env.discord.calls.lock().unwrap().len(), 1);
        } else {
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            assert!(env.discord.calls.lock().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn refresh_verification_outages_return_unauthorized_without_reading_grants() {
    let id = ObjectId::new();
    for cause in [
        "missing client",
        "offline",
        "invalid response",
        "signing keys offline",
        "invalid envelope",
    ] {
        let mut env = setup_env(
            Arc::new(MockHttp::new(move |_| {
                if cause == "invalid response" {
                    Ok(UpstreamHttpResponse {
                        status: 503,
                        body: b"[".to_vec(),
                    })
                } else {
                    Err(CoreError::Upstream("fixture provider unavailable".into()))
                }
            })),
            None,
        );
        if cause == "missing client" {
            Arc::make_mut(&mut env.state.config).epic_client_id = None;
        }
        let issuer = if cause == "signing keys offline" {
            "https://api.epicgames.dev/epic/id"
        } else {
            "https://api.epicgames.dev/epic/oauth/v2"
        };
        let (private, _, _) = crate::account_admin::tests::rsa_keypair_pem();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("kid-1".into());
        let token = encode(&header,&json!({"sub":"fixture-owner","iss":issuer,"aud":"epic-client-id","exp":fixed_now().timestamp()+3600,"iat":fixed_now().timestamp()}),&EncodingKey::from_rsa_pem(private.as_bytes()).unwrap()).unwrap();
        let path = if cause == "invalid envelope" {
            "/auth/v2/refresh".into()
        } else {
            format!("/auth/refresh?id={id}")
        };
        env.mongo.fail_on("tokens", "find_one", 1);
        let (status, _) = request(&env.state, "GET", &path, Some(&token), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{cause}");
        assert!(env.mongo.fault.lock().unwrap().is_some());
    }
}

#[tokio::test]
async fn incomplete_discord_sessions_return_home_without_creating_link_state() {
    let http = Arc::new(MockHttp::new(|_| Ok(epic_token_info_ok("fixture-owner"))));
    for session_id in [None, Some(json!("")), Some(json!(12))] {
        let mut session = sample_session("fixture-owner@fixture.invalid");
        if let Some(id) = session_id {
            session.claims.insert("sessionId".into(), id);
        } else {
            session.claims.remove("sessionId");
        }
        let env = setup_env(http.clone(), Some(session));
        for path in ["/auth/discord/link", "/auth/discord/callback"] {
            let response = router_for(&env.state)
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::COOKIE, "better-auth.session_token=valid")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.headers()[header::LOCATION], "https://egdata.app/");
        }
        assert!(env.redis.store.lock().unwrap().is_empty());
    }
    let env = setup_env(http, None);
    let token = sign_rs256(&json!({"sub":"fixture-owner","appid":"fixture-app"}));
    let (status, _) = request(&env.state, "GET", "/auth/discord/link", Some(&token), None).await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(env.redis.store.lock().unwrap().is_empty());
}
