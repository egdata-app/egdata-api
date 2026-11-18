use super::*;

fn backend_error() -> CoreError {
    CoreError::Upstream("fixture unavailable".into())
}
fn invalid_json() -> CoreRes<UpstreamHttpResponse> {
    Ok(UpstreamHttpResponse {
        status: 200,
        body: b"[".to_vec(),
    })
}
fn verified_session(h: &Harness) {
    *h.session.result.lock().unwrap() = Some(Ok(Some(sample_session("fixture@fixture.invalid"))));
}

#[tokio::test]
async fn account_and_catalog_requested_without_a_linked_account() {
    for (method, path) in [
        ("POST", "/donate/key/12345678901234567890"),
        ("POST", "/offers/o/reviews"),
        ("PATCH", "/offers/o/reviews"),
        ("DELETE", "/offers/o/reviews"),
        ("GET", "/offers/o/reviews/permissions"),
    ] {
        let h = make_harness(ApiConfig::default());
        let mut session = sample_session("fixture@fixture.invalid");
        session.claims.remove("epicAccountId");
        *h.session.result.lock().unwrap() = Some(Ok(Some(session)));
        let (status, body, _) = call(
            &h.state,
            method,
            path,
            &[],
            Some(json!({"rating":5,"title":"Local","content":"Text"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
        assert!(body["error"].is_string());
        assert!(h.mongo.inserted.lock().unwrap().is_empty());
        assert!(h.mongo.updated.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn donation_storage_and_upstream_failures() {
    let path = "/donate/key/12345678901234567890";
    for fault in [
        "get",
        "duplicate-check",
        "missing-launcher",
        "launcher-database",
        "http",
        "bad-json",
        "insert",
        "account-lookup",
    ] {
        let h = make_harness(ApiConfig {
            admin_account_id: Some("fixture-admin".into()),
            ..Default::default()
        });
        verified_session(&h);
        if matches!(fault, "get" | "duplicate-check") {
            h.mongo.push_find_one("key-codes", Err(backend_error()));
        } else {
            h.mongo.push_find_one("key-codes", Ok(None));
            h.mongo.push_find_one(
                "launcher",
                match fault {
                    "missing-launcher" => Ok(None),
                    "launcher-database" => Err(backend_error()),
                    _ => Ok(Some(doc! {"access_token":"fixture-local"})),
                },
            );
            h.http.push(match fault {
                "http" => Err(backend_error()),
                "bad-json" => invalid_json(),
                _ => Ok(UpstreamHttpResponse {
                    status: 200,
                    body: br#"{"offerId":"offer","identityId":"identity","details":[]}"#.to_vec(),
                }),
            });
            if fault == "insert" {
                *h.mongo.insert_err.lock().unwrap() = Some(backend_error());
            }
            if fault == "account-lookup" {
                h.mongo.push_find_one("epic", Err(backend_error()));
            }
        }
        let method = if fault == "get" { "GET" } else { "POST" };
        let (status, body, _) = call(&h.state, method, path, &[], None).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("Internal Server Error")
            ),
            "{fault}"
        );
        assert!(h.discord.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn accounts_reads_handle_invalid_records_and_provider_failures() {
    let secret = "0123456789abcdef0123456789abcdef";
    let encrypted = encrypt_with_iv("fixture-user", secret.as_bytes(), &[8; 16]).unwrap();
    for fault in [
        "missing-id",
        "invalid-record",
        "storage",
        "provider",
        "provider-json",
    ] {
        let h = make_harness(ApiConfig {
            jwt_secret: "fixture-secret".into(),
            cookie_secret: secret.into(),
            ..Default::default()
        });
        let claims = match fault {
            "missing-id" => json!({}),
            "invalid-record" => json!({"id":"invalid"}),
            _ => json!({"id":&encrypted}),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"fixture-secret"),
        )
        .unwrap();
        h.mongo.push_find_one(
            "googleauths",
            if fault == "storage" {
                Err(backend_error())
            } else {
                Ok(Some(doc! {"access_token":"fixture-token"}))
            },
        );
        h.http.push(if fault == "provider-json" {
            invalid_json()
        } else {
            Err(backend_error())
        });
        let (status, body, _) = call(
            &h.state,
            "GET",
            "/accounts",
            &[("authorization", &format!("Bearer {token}"))],
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
}

#[tokio::test]
async fn launcher_reports_unavailable_catalog_and_upstream_failures() {
    let (private, public, _) = rsa_keypair_pem();
    let valid = encode(
        &Header::new(Algorithm::RS256),
        &json!({"client_id":LAUNCHER_CLIENT_ID,"exp":Utc::now().timestamp()+3600}),
        &EncodingKey::from_rsa_pem(private.as_bytes()).unwrap(),
    )
    .unwrap();
    for (fault, path) in [
        ("missing-config", "/launcher/sandbox/ns"),
        ("missing-token", "/launcher/sandbox/ns/items"),
        ("database", "/launcher/sandbox/ns/offers"),
        ("transport", "/launcher/sandbox/ns"),
        ("provider-json", "/launcher/sandbox/ns/items"),
        ("items-ok", "/launcher/sandbox/ns/items?count=2"),
    ] {
        let h = make_harness(ApiConfig {
            jwt_public_key_pem: Some(public.clone()),
            admin_account_id: (fault != "missing-config").then(|| "fixture-admin".into()),
            ..Default::default()
        });
        h.mongo.push_find_one(
            "launcher",
            match fault {
                "database" => Err(backend_error()),
                "missing-token" => Ok(Some(doc! {"access_token":""})),
                _ => Ok(Some(doc! {"access_token":"fixture-local"})),
            },
        );
        h.http.push(match fault {
            "transport" => Err(backend_error()),
            "provider-json" => invalid_json(),
            _ => Ok(UpstreamHttpResponse {
                status: 200,
                body: b"[]".to_vec(),
            }),
        });
        let (status, body, _) = call(
            &h.state,
            "GET",
            path,
            &[("authorization", &format!("Bearer {valid}"))],
            None,
        )
        .await;
        let expected = if fault == "items-ok" {
            (StatusCode::OK, json!([]))
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("Internal Server Error"),
            )
        };
        assert_eq!((status, body), expected, "{fault}");
    }
}

#[tokio::test]
async fn review_edits_report_storage_failures_at_each_read_or_write() {
    for fault in ["offers", "sandboxes", "products", "reviews", "update"] {
        let h = make_harness(ApiConfig::default());
        verified_session(&h);
        for (collection, row) in [
            ("offers", doc! {"namespace":"ns"}),
            ("sandboxes", doc! {"parent":"product"}),
            ("products", doc! {"_id":"product"}),
            ("reviews", doc! {"id":"offer"}),
        ] {
            h.mongo.push_find_one(
                collection,
                if collection == fault {
                    Err(backend_error())
                } else {
                    Ok(Some(row))
                },
            );
        }
        *h.mongo.update_err.lock().unwrap() = Some(backend_error());
        let (status, body, _) = call(
            &h.state,
            "PATCH",
            "/offers/offer/reviews",
            &[],
            Some(json!({"rating":4,"title":"Title","content":"Text","tags":[]})),
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
}
#[test]
fn historical_product_ids_and_incomplete_account_contexts() {
    assert_eq!(bson_to_string_id(&Bson::Int32(7)), "");
    assert_eq!(
        bson_to_string_id(&Bson::DateTime(bson::DateTime::from_millis(0))),
        "1970-01-01T00:00:00.000Z"
    );
    let ctx = crate::legacy::auth::EpicAuthContext {
        epic: None,
        session: None,
    };
    assert!(matches!(
        linked_account(&ctx),
        Err(Error::Json(StatusCode::UNAUTHORIZED, _))
    ));
}

#[tokio::test]
async fn provider_identity_and_payload_failures_are_reported() {
    let h = make_harness(ApiConfig::default());
    for response in [invalid_json(), Err(backend_error())] {
        h.http.push(response);
        assert!(post_token_info(&h.state, "fixture-local").await.is_err());
    }
    h.http.push(invalid_json());
    let (status, body, _) = call(
        &h.state,
        "GET",
        "/users/discord",
        &[("authorization", "Bearer fixture-local")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        "Failed to fetch user information from Discord"
    );

    for method in ["PUT", "DELETE"] {
        h.http.push_json(200, json!({"user":{"id":""}}));
        let (status, body, _) = call(
            &h.state,
            method,
            "/users/epic?id=fixture",
            &[("authorization", "Bearer fixture-local")],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "User not found");
    }
    h.http.push_json(200, json!({"user":{"id":"fixture"}}));
    h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
    h.mongo.push_find_one("users", Err(backend_error()));
    let (status, body, _) = call(
        &h.state,
        "GET",
        "/users/discord",
        &[("authorization", "Bearer fixture-local")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        "Failed to fetch user information from Discord"
    );
}
#[tokio::test]
async fn verified_services_handle_bad_requests_and_upstream_failures() {
    let token = encode(
        &Header::new(Algorithm::HS256),
        &json!({"sub":"fixture","exp":fixed_now().timestamp()+3600}),
        &EncodingKey::from_secret(b"fixture-issuer"),
    )
    .unwrap();
    let credential = format!("Bearer {token}");
    for (path, payload, fault, status, expected) in [
        (
            "/users-service",
            None,
            "provider-error",
            401,
            json!({"error":"Invalid JWT"}),
        ),
        (
            "/users-service",
            None,
            "provider-revoked",
            401,
            json!({"error":"Invalid JWT"}),
        ),
        (
            "/users-service/playtime",
            None,
            "empty-body",
            500,
            json!("Internal Server Error"),
        ),
        (
            "/users-service/playtime",
            Some(json!({})),
            "bad-shape",
            500,
            json!("Internal Server Error"),
        ),
        (
            "/users-service/playtime",
            Some(json!([{"accountId":"fixture","artifactId":"artifact","totalTime":3}])),
            "update",
            500,
            json!("Internal Server Error"),
        ),
        (
            "/users-service/ownership",
            None,
            "empty-body",
            500,
            json!("Internal Server Error"),
        ),
        (
            "/users-service/ownership",
            Some(json!(true)),
            "bad-shape",
            500,
            json!("Internal Server Error"),
        ),
        (
            "/users-service/ownership",
            Some(json!([{"id":"offer"}])),
            "provider-json",
            200,
            Value::Null,
        ),
        (
            "/users-service/ownership",
            Some(json!([])),
            "service-error",
            200,
            Value::Null,
        ),
    ] {
        let h = make_harness(ApiConfig::default());
        match fault {
            "provider-error" => h.http.push(Err(backend_error())),
            "provider-revoked" => h.http.push_json(401, json!({"error":"expired"})),
            _ => h
                .http
                .push_json(200, json!({"active":true,"account_id":"fixture"})),
        }
        if fault == "provider-json" {
            h.http.push(invalid_json());
        }
        if fault == "service-error" {
            h.http.push(Err(backend_error()));
        }
        if fault == "update" {
            *h.mongo.update_err.lock().unwrap() = Some(backend_error());
        }
        let method = if path == "/users-service" {
            "GET"
        } else {
            "POST"
        };
        let (actual, body, _) = call(
            &h.state,
            method,
            path,
            &[("authorization", &credential)],
            payload,
        )
        .await;
        assert_eq!(
            (actual.as_u16(), body),
            (status, expected),
            "{path} {fault}"
        );
    }
}

#[test]
fn token_decoder_rejects_incomplete_or_malformed_payloads() {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#);
    let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"fixture"}"#);
    for raw in [
        String::new(),
        ".".into(),
        "..".into(),
        format!("{header}.{payload}.one.extra"),
        format!("%.{payload}.sig"),
        format!("{}.{}.sig", URL_SAFE_NO_PAD.encode(b"null"), payload),
        format!("{}.{}.sig", URL_SAFE_NO_PAD.encode(b"["), payload),
        format!("{header}.%.sig"),
        format!("{header}.{}.sig", URL_SAFE_NO_PAD.encode(b"[")),
    ] {
        assert!(decode_jwt_payload(&raw).is_none(), "{raw}");
    }
}

#[tokio::test]
async fn credentials_and_catalog_dependency_failures() {
    let (_, public, _) = rsa_keypair_pem();
    let h = make_harness(ApiConfig {
        jwt_public_key_pem: Some("invalid-config".into()),
        ..Default::default()
    });
    let (status, body, _) = call(
        &h.state,
        "GET",
        "/launcher/sandbox/ns",
        &[("authorization", "Bearer fixture-local")],
        None,
    )
    .await;
    assert_eq!(
        (status, body),
        (StatusCode::UNAUTHORIZED, json!({"error":"Invalid JWT"}))
    );
    let h = make_harness(ApiConfig {
        jwt_public_key_pem: Some(public),
        ..Default::default()
    });
    let header = STANDARD.encode(
        serde_json::to_vec(&json!({"user":{"accountId":"fixture","accessToken":"local"}})).unwrap(),
    );
    for bad in ["%%%", "aW52YWxpZA=="] {
        let (status, body, _) = call(
            &h.state,
            "GET",
            "/admin",
            &[("cookie", &format!("EGDATA_AUTH={bad}.fixture"))],
            None,
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("Internal Server Error")
            )
        );
    }
    for failed in [invalid_json(), Err(backend_error())] {
        h.http.push(failed);
        let (status, body, _) = call(
            &h.state,
            "GET",
            "/admin",
            &[("cookie", &format!("EGDATA_AUTH={header}.fixture"))],
            None,
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("Internal Server Error")
            )
        );
    }
    assert_eq!(decode_base64_segment("____").unwrap(), vec![255, 255, 255]);
    assert_eq!(decode_base64_segment("_w").unwrap(), vec![255]);

    for (method, path) in [
        ("GET", "/offers/demo/ownership"),
        ("PATCH", "/offers/demo/reviews"),
    ] {
        let body = (method == "PATCH")
            .then(|| json!({"rating":3,"title":"Title","content":"text","tags":[]}));
        verified_session(&h);
        h.mongo.push_find_one("offers", Err(backend_error()));
        let (status, res, _) = call(&h.state, method, path, &[], body).await;
        assert_eq!(
            (status, res),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("Internal Server Error")
            )
        );
    }
}
#[tokio::test]
async fn auth_consumers_handle_degraded_provider_responses() {
    // A verified-session provider with a temporarily incomplete identity must
    // never enable a write belonging to another account.
    struct IncompleteSession;
    #[async_trait]
    impl SessionVerifierPort for IncompleteSession {
        async fn verify_token(&self, _: &str) -> CoreRes<Option<VerifiedSession>> {
            let mut session = sample_session("fixture@fixture.invalid");
            session.claims.remove("epicAccountId");
            Ok(Some(session))
        }
        async fn verify_epic_session(&self, cookie: &str) -> CoreRes<Option<VerifiedSession>> {
            self.verify_token(cookie).await
        }
    }
    let mut h = make_harness(ApiConfig::default());
    h.state.session_verifier = Arc::new(IncompleteSession);
    for (method, path) in [
        ("POST", "/donate/key/12345678901234567890"),
        ("POST", "/offers/fixture/reviews"),
        ("PATCH", "/offers/fixture/reviews"),
        ("DELETE", "/offers/fixture/reviews"),
        ("GET", "/offers/fixture/reviews/permissions"),
    ] {
        let (status, body, _) = call(
            &h.state,
            method,
            path,
            &[],
            Some(json!({"rating":3,"title":"T","content":"C","tags":[]})),
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::UNAUTHORIZED,
                json!({"error":"Missing account ID"})
            ),
            "{method} {path}"
        );
    }
    h.mongo
        .push_find_one("offers", Ok(Some(doc! {"namespace":"ns"})));
    h.mongo
        .push_find_one("sandboxes", Ok(Some(doc! {"parent":"product"})));
    h.mongo
        .push_find_one("products", Ok(Some(doc! {"_id":"product"})));
    let (status, body, _) = call(&h.state, "GET", "/offers/fixture/ownership", &[], None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"isOwned":false})));
    assert!(h.mongo.inserted.lock().unwrap().is_empty());
    assert!(h.mongo.updated.lock().unwrap().is_empty());

    let h = make_harness(ApiConfig::default());
    for (method, path) in [
        ("POST", "/users-service/ownership"),
        ("POST", "/users-service/playtime"),
        ("GET", "/launcher/sandbox/ns/offers"),
    ] {
        let (status, _, _) = call(&h.state, method, path, &[], None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    for collection in ["offers", "sandboxes", "products"] {
        h.mongo.push_find_one(
            collection,
            Ok(Some(match collection {
                "offers" => doc! {"namespace":"ns"},
                "sandboxes" => doc! {"parent":"product"},
                _ => doc! {"_id":"product"},
            })),
        );
    }
    verified_session(&h);
    h.epic
        .user_res
        .lock()
        .unwrap()
        .push_back(Ok(Some(json!({"id":"fixture"}))));
    h.epic
        .gql_res
        .lock()
        .unwrap()
        .push_back(Ok(json!({"data":{"PlayerProfile":null}})));
    let (status, body, _) = call(&h.state, "GET", "/offers/fixture/ownership", &[], None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"isOwned":false})));
}

#[tokio::test]
async fn push_and_account_writes_propagate_late_store_errors() {
    let h = make_harness(ApiConfig {
        push_admin_api_key: Some("fixture-admin".into()),
        vapid_public_key: Some("public".into()),
        vapid_private_key: Some("private".into()),
        ..Default::default()
    });
    h.mongo.push_find_many("pushsubscriptions", Ok(vec![]));
    h.mongo
        .push_find_many("pushsubscriptions", Err(backend_error()));
    let (status, body, _) = call(
        &h.state,
        "POST",
        "/push/send",
        &[("x-api-key", "fixture-admin")],
        Some(json!({"topic":"a:b","notification":{"title":"T","body":"B"}})),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"Failed to send notification"})
        )
    );
    *h.mongo.insert_err.lock().unwrap() = Some(backend_error());
    let (status, body, _) = call(
        &h.state,
        "POST",
        "/push/subscribe",
        &[("x-api-key", "fixture-local")],
        Some(json!({"endpoint":"https://push.invalid","keys":{"auth":"local","p256dh":"example"}})),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"Failed to subscribe"})
        )
    );
    for method in ["PUT", "DELETE"] {
        h.http.push_json(200, json!({"user":{"id":"fixture"}}));
        h.mongo.push_find_one("users", Ok(Some(doc! {"_id":1})));
        h.mongo.push_find_one("users", Err(backend_error()));
        h.epic
            .user_res
            .lock()
            .unwrap()
            .push_back(Ok(Some(json!({"epicAccountId":"fixture-epic"}))));
        let (status, body, _) = call(
            &h.state,
            method,
            "/users/epic?id=fixture-epic",
            &[("authorization", "Bearer fixture-local")],
            None,
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::BAD_REQUEST,
                json!({"error":"Failed to fetch user information from Epic Games"})
            )
        );
    }
}

#[tokio::test]
async fn launcher_rejects_invalid_resource_identifiers_before_lookup() {
    let (private, public, _) = rsa_keypair_pem();
    let h = make_harness(ApiConfig {
        jwt_public_key_pem: Some(public),
        ..Default::default()
    });
    let token = encode(
        &Header::new(Algorithm::RS256),
        &json!({"client_id":LAUNCHER_CLIENT_ID,"exp":Utc::now().timestamp()+3600}),
        &EncodingKey::from_rsa_pem(private.as_bytes()).unwrap(),
    )
    .unwrap();
    for path in [
        "/launcher/sandbox/.",
        "/launcher/sandbox/./items",
        "/launcher/sandbox/./offers",
    ] {
        let (status, body, _) = call(
            &h.state,
            "GET",
            path,
            &[("authorization", &format!("Bearer {token}"))],
            None,
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::BAD_REQUEST,
                json!({"error":"Invalid sandbox id"})
            )
        );
    }
    assert!(h.http.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn rejected_admin_write_leaves_public_catalog_unchanged() {
    let h = make_harness(ApiConfig::default());
    let (status, body, _) = call(
        &h.state,
        "POST",
        "/admin/offers",
        &[],
        Some(json!({"id":"private-write","seller":"fixture-seller","title":"fixture"})),
    )
    .await;
    assert_eq!(
        (status, body),
        (StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"}))
    );
    assert!(h.mongo.inserted.lock().unwrap().is_empty());
    for path in [
        "/sellers",
        "/featured",
        "/offers/private-write/reviews",
        "/health",
    ] {
        let (status, body, _) = call(&h.state, "GET", path, &[], None).await;
        assert_eq!(status, StatusCode::OK, "{path} {body}");
        match path {
            "/offers/private-write/reviews" => assert_eq!(body["total"], 0),
            "/health" => assert_eq!(body["services"]["mongodb"]["status"], "ok"),
            _ => assert_eq!(body, json!([])),
        }
    }
}

#[tokio::test]
async fn optional_review_and_provider_fields_are_handled() {
    let h = make_harness(ApiConfig {
        admin_account_id: Some("fixture".into()),
        ..Default::default()
    });
    verified_session(&h);
    h.mongo
        .push_find_one("launcher", Ok(Some(doc! {"access_token":"fixture-local"})));
    h.http
        .push_json(200, json!({"offerId":"fixture","details":{}}));
    let (status, _, _) = call(
        &h.state,
        "POST",
        "/donate/key/12345678901234567890",
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(h.discord.calls.lock().unwrap().is_empty());
    let (status, body, _) = call(
        &h.state,
        "POST",
        "/users/find-or-create",
        &[("authorization", "Bearer fixture-local")],
        Some(json!({"id":"local"})),
    )
    .await;
    assert_eq!(
        (status, body),
        (StatusCode::BAD_REQUEST, json!({"error":"Invalid token"}))
    );
    verified_session(&h);
    let (status, body) = call_raw(&h.state, "PATCH", "/offers/fixture/reviews", &[], b"[").await;
    assert_eq!(
        (status, body),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!("Internal Server Error")
        )
    );
    verified_session(&h);
    h.mongo
        .push_find_one("offers", Ok(Some(doc! {"namespace":"ns"})));
    h.mongo
        .push_find_one("sandboxes", Ok(Some(doc! {"parent":"p"})));
    h.mongo
        .push_find_one("products", Ok(Some(doc! {"_id":"p"})));
    h.mongo
        .push_find_one("reviews", Ok(Some(doc! {"id":"fixture"})));
    let (status, body, _) = call(
        &h.state,
        "PATCH",
        "/offers/fixture/reviews",
        &[],
        Some(json!({"title":"T","rating":4,"content":"C","tags":null})),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!("Internal Server Error")
        )
    );

    let credential = encode(
        &Header::new(Algorithm::HS256),
        &json!({"sub":"fixture"}),
        &EncodingKey::from_secret(b"local-fixture-issuer"),
    )
    .unwrap();
    h.http
        .push_json(200, json!({"active":true,"account_id":"fixture"}));
    h.http.push_json(
        200,
        json!({"Entitlements":{"cartOffersValidation":{"fullyOwnedOffers":[]}}}),
    );
    let (status, body, _) = call(
        &h.state,
        "POST",
        "/users-service/ownership",
        &[("authorization", &format!("Bearer {credential}"))],
        Some(json!([])),
    )
    .await;
    assert_eq!(
        (status, body),
        (StatusCode::OK, json!({"fullyOwnedOffers":[]}))
    );
}
