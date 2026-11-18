use super::*;
use crate::v1::mongo_read_oracle::RecordedReads;

#[tokio::test]
async fn verified_auth_service_http_matches_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/legacy-auth-services-http-node.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let queue = Arc::new(Mutex::new(std::collections::VecDeque::from(
            case["http"].as_array().unwrap().clone(),
        )));
        let exchanges = queue.clone();
        let http = Arc::new(MockHttp::new(move |sent| {
            let exchange = exchanges
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected provider request");
            let expected = &exchange["request"];
            assert_eq!(sent.method, expected["method"]);
            assert_eq!(sent.url, expected["url"]);
            assert_eq!(
                sent.body
                    .as_deref()
                    .map(|b| std::str::from_utf8(b).unwrap()),
                expected["body"].as_str()
            );
            let headers = sent
                .headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v))
                .collect::<BTreeMap<_, _>>();
            assert_eq!(json!(headers), expected["headers"]);
            let multipart = sent.multipart_file.as_ref().map(|f| {
                json!({
                    "field":f.field_name, "name":f.filename, "type":f.content_type,
                    "contents":std::str::from_utf8(&f.bytes).unwrap(),
                })
            });
            assert_eq!(multipart.as_ref(), expected.get("multipart"));
            if exchange["unavailable"] == true {
                return Err(CoreError::Upstream("fixture provider unavailable".into()));
            }
            Ok(UpstreamHttpResponse {
                status: exchange["status"].as_u64().unwrap() as u16,
                body: match exchange["raw"].as_str() {
                    Some(raw) => raw.as_bytes().to_vec(),
                    None => serde_json::to_vec(&exchange["result"]).unwrap(),
                },
            })
        }));
        let mut env = setup_env(http, Some(sample_session("fixture-owner@fixture.invalid")));
        let config = Arc::make_mut(&mut env.state.config);
        config.epic_client_id = Some("fixture-client".into());
        config.epic_client_secret = Some("fixture-secret".into());
        config.cloudflare_images_token = Some("fixture-images-key".into());
        config.jwt_public_key_pem =
            Some(include_str!("../../../../../oracles/account-fixture-rsa-public.pem").into());
        let recorded = Arc::new(RecordedReads::from_case(&case));
        env.state.mongo = recorded.clone();
        env.state.saved_queries = recorded.clone();
        let req = &case["request"];
        let mut builder = Request::builder()
            .method(req["method"].as_str().unwrap())
            .uri(req["path"].as_str().unwrap());
        for (k, v) in req["headers"].as_object().into_iter().flatten() {
            builder = builder.header(k, v.as_str().unwrap());
        }
        let body = req["rawBody"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| req.get("body").map(Value::to_string))
            .unwrap_or_default();
        let routes = if req["path"].as_str().unwrap().starts_with("/users-service") {
            crate::legacy::account_admin::routes()
        } else {
            super::super::routes()
        };
        let resp = routes
            .into_router(&env.state)
            .with_state(env.state.clone())
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let expected = &case["response"];
        assert_eq!(
            resp.status().as_u16() as u64,
            expected["status"],
            "{name} status"
        );
        for (k, v) in expected["headers"]
            .as_object()
            .unwrap()
            .iter()
            .chain(case["cors"].as_object().unwrap())
        {
            assert_eq!(
                resp.headers().get(k).and_then(|h| h.to_str().ok()),
                v.as_str(),
                "{name} {k}"
            );
        }
        if resp.status() == StatusCode::OK && req["path"] == "/auth/v2/refresh" {
            assert_eq!(
                resp.headers().get(header::CACHE_CONTROL).unwrap(),
                "private, no-store"
            );
        }
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let actual = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap()));
        assert_eq!(actual, expected["body"], "{name} body");
        recorded.assert_finished();
        assert!(
            queue.lock().unwrap().is_empty(),
            "{name} unused provider replies"
        );
    }
}
