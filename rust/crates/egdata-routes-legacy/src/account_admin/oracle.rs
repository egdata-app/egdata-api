use super::*;
use egdata_api_oracle::RecordedReads;

#[tokio::test]
async fn node_http_and_database_traces() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../egdata-api/tests/fixtures/legacy-account-admin-http-node.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut h = make_harness(ApiConfig {
            google_client_id: Some("fixture-google-client".into()),
            push_admin_api_key: Some("fixture-admin".into()),
            vapid_public_key: Some("fixture-public".into()),
            vapid_private_key: Some("fixture-private".into()),
            ..Default::default()
        });
        let mongo = Arc::new(RecordedReads::from_case(&case));
        if case["session"] == true {
            *h.session.result.lock().unwrap() =
                Some(Ok(Some(sample_session("fixture-account@fixture.invalid"))));
        }
        h.state.new_object_id =
            || bson::oid::ObjectId::parse_str("000000000000000000000011").unwrap();
        h.state.mongo = mongo.clone();
        h.state.epic = mongo.clone();
        let upstream = case["http"].as_array().unwrap();
        for exchange in upstream {
            h.http.push_json(
                exchange["status"].as_u64().unwrap() as u16,
                exchange["result"].clone(),
            );
        }
        let mut deliveries = case["deliveries"].as_array().unwrap().clone();
        for delivery in &mut deliveries {
            let outcome = delivery.as_object_mut().unwrap().remove("outcome").unwrap();
            let result = match outcome.as_str().unwrap() {
                "expired" => Err(CoreError::NotFound("Gone".into())),
                "failed" => Err(CoreError::Internal("fixture unavailable".into())),
                "unnamed" => Err(CoreError::Internal(String::new())),
                success => {
                    assert_eq!(success, "sent", "unknown fixture outcome");
                    Ok(())
                }
            };
            h.push.outcomes.lock().unwrap().push_back(result);
        }
        let request = &case["request"];
        let mut builder = axum::http::Request::builder()
            .method(request["method"].as_str().unwrap())
            .uri(request["path"].as_str().unwrap());
        for (key, v) in request["headers"].as_object().into_iter().flatten() {
            builder = builder.header(key, v.as_str().unwrap());
        }
        let body = request["rawBody"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| request.get("body").map(Value::to_string))
            .unwrap_or_default();
        let app = crate::router(&h.state).with_state(h.state.clone());
        let response = app
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let expected = &case["response"];
        assert_eq!(
            response.status().as_u16() as u64,
            expected["status"],
            "{name} status"
        );
        for (key, v) in expected["headers"].as_object().unwrap() {
            assert_eq!(
                response.headers().get(key).unwrap().to_str().unwrap(),
                v.as_str().unwrap(),
                "{name} {key}"
            );
        }
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let actual = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap()));
        assert_eq!(actual, expected["body"], "{name} body");
        mongo.assert_finished();
        assert_eq!(
            *h.push.deliveries.lock().unwrap(),
            deliveries,
            "{name} dispatched messages"
        );
        let requests = h.http.requests.lock().unwrap();
        assert_eq!(requests.len(), upstream.len(), "{name} upstream calls");
        for (sent, expected) in requests.iter().zip(upstream) {
            assert_eq!(sent.method, expected["method"], "{name} upstream method");
            assert_eq!(sent.url, expected["url"], "{name} upstream URL");
            let headers: std::collections::BTreeMap<_, _> = sent
                .headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v))
                .collect();
            assert_eq!(
                json!(headers),
                expected["headers"],
                "{name} upstream headers"
            );
            assert_eq!(
                sent.body
                    .as_deref()
                    .map(|b| std::str::from_utf8(b).unwrap()),
                expected["body"].as_str(),
                "{name} upstream body"
            );
        }
    }
}

#[test]
fn mongo_driver_literal_json_bytes() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../egdata-api/tests/fixtures/legacy-account-json-bson-node.json"
    ))
    .unwrap();
    for case in cases {
        let raw = case["raw"].as_str().unwrap();
        let value: Value = serde_json::from_str(raw).unwrap();
        let actual = bson::to_vec(&doc! {"value":account_bson(&value)}).unwrap();
        assert_eq!(hex::encode(actual), case["bytes"], "{raw}");
    }
}
