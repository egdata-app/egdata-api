use super::*;
use egdata_core::ports::EpicStorePort;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Profile,
    Product,
    Summaries,
    Ownership,
    Featured,
    Discord,
}

pub(super) struct Request {
    pub(super) path: String,
    pub(super) body: String,
    method: String,
    headers: HashMap<String, String>,
}

pub(super) async fn read_request(socket: &mut TcpStream) -> Request {
    let mut reader = BufReader::new(socket);
    let mut first = String::new();
    reader.read_line(&mut first).await.unwrap();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap().to_owned();
    let path = parts.next().unwrap().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.unwrap();
        assert_ne!(n, 0, "incomplete HTTP request");
        if line == "\r\n" {
            break;
        }
        let (name, value) = line.split_once(':').unwrap();
        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
    }
    let mut data = vec![
        0;
        headers
            .get("content-length")
            .map_or(0, |v| v.parse::<usize>().unwrap())
    ];
    reader.read_exact(&mut data).await.unwrap();
    Request {
        path,
        method,
        headers,
        body: String::from_utf8(data).unwrap(),
    }
}

async fn capture(case: &Value) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let case = case.clone();
    let task = tokio::spawn(async move {
        let name = &case["name"];
        if case["requests"] == json!([]) {
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept())
                    .await
                    .is_err(),
                "unexpected connection for {name}"
            );
            return;
        }
        let (mut socket, _) = listener.accept().await.unwrap();
        let req = read_request(&mut socket).await;
        assert_eq!(req.path, "/");
        let expected = &case["requests"][0];
        assert_eq!(req.method, expected["method"], "{name}");
        for (header, value) in expected["headers"].as_object().unwrap() {
            assert_eq!(
                req.headers.get(header).map(String::as_str),
                value.as_str(),
                "header {header} for {name}"
            );
        }
        assert_eq!(
            req.headers.contains_key("authorization"),
            expected["headers"]["authorization"].is_string()
        );
        if let Some(expected_body) = expected.get("body") {
            let mut actual: Value = serde_json::from_str(&req.body).unwrap();
            actual["query"] = actual["query"]
                .as_str()
                .unwrap()
                .split_whitespace()
                .collect::<String>()
                .replace(',', "")
                .into();
            assert_eq!(&actual, expected_body, "{name}");
        }
        let input = &case["input"];
        if input["drop"] == true {
            return;
        }
        let body = input["raw"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| input["body"].to_string());
        let status = input["status"].as_u64().unwrap_or(200);
        let content_type = input["type"].as_str().unwrap_or("application/json");
        let response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (format!("http://{addr}"), task)
}

#[tokio::test]
async fn interrupted_raw_graphql_body_is_a_transport_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{")
            .await
            .unwrap();
    });
    let client = EpicStoreClient::with_urls(&base, &base, &base, Client::new());
    let error = client
        .graphql_raw("query {}", &json!({}))
        .await
        .unwrap_err();
    assert!(error.to_string().starts_with("http error:"));
    server.await.unwrap();
}

#[tokio::test]
async fn upstream_operations_match_canonical_clients() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/epic-client-node.json"
    ))
    .unwrap();
    for case in cases {
        let (url, server) = capture(&case).await;
        let client = EpicStoreClient::with_urls(&url, &url, &url, Client::new());
        let name = &case["name"];
        let operation: Operation = serde_json::from_value(case["op"].clone()).unwrap();
        let output = match operation {
            Operation::Profile => json!({"value":client.get_user("fixture").await}),
            Operation::Summaries => json!({"value":client.get_user_achievements("fixture").await}),
            Operation::Product => {
                json!({"value":client.get_user_product_achievements("fixture","product").await})
            }
            Operation::Ownership => {
                let result = client
                    .check_ownership(
                        &[OfferToValidate {
                            offer_id: "one".into(),
                            namespace: "ns".into(),
                        }],
                        case["input"]["token"].as_str().unwrap_or("fixture-token"),
                    )
                    .await;
                let value = match result {
                    OwnershipCheckResult::Validation(v) => json!(v),
                    OwnershipCheckResult::GraphQlErrors(v) => json!(v),
                    OwnershipCheckResult::Unavailable => Value::Null,
                };
                json!({"value":value})
            }
            Operation::Featured => match EpicStorePort::featured_games(&client).await {
                Ok(v) => json!({"value":v}),
                Err(_) => json!({"error":"upstream"}),
            },
            Operation::Discord => match client.get_discord_user("fixture-token").await {
                Ok(Some(user)) => {
                    let mut value = json!(user);
                    value.as_object_mut().unwrap().retain(|_, v| !v.is_null());
                    json!({"value":value})
                }
                Ok(None) => json!({"value":null}),
                Err(ref e @ EpicClientError::DiscordHttp(_)) => json!({"error":e.to_string()}),
                Err(_) => json!({"error":"upstream"}),
            },
        };
        server.await.unwrap();
        assert_eq!(output, case["output"], "{name}");
    }
}
