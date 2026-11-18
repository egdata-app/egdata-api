use egdata_infra::search_clients::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

async fn replay(case: &Value) -> (Value, Vec<Value>) {
    let input = &case["input"];
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&requests);
    let replies = input["replies"].as_array().unwrap().clone();
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut reader = BufReader::new(&mut socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap().to_owned();
            let path = parts.next().unwrap().to_owned();
            let mut auth = None;
            let mut length = 0;
            let mut header_line = Vec::new();
            loop {
                header_line.clear();
                if reader.read_until(b'\n', &mut header_line).await.unwrap() == 0
                    || header_line == b"\r\n"
                {
                    break;
                }
                let header_line: String = header_line.iter().copied().map(char::from).collect();
                let (key, value) = header_line.split_once(':').unwrap();
                if key.eq_ignore_ascii_case("authorization") {
                    assert!(auth.is_none(), "duplicate Authorization header");
                    auth = Some(value.trim().to_owned());
                }
                if key.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).await.unwrap();
            let step = {
                let mut seen = capture.lock().unwrap();
                let i = seen.len();
                seen.push(json!({"method":method,"path":path,"auth":auth,"body":String::from_utf8(body).unwrap()}));
                i
            };
            let fallback = json!({"status":400,"body":"{}","type":"application/json"});
            let response = replies
                .get(step)
                .or_else(|| replies.last())
                .unwrap_or(&fallback);
            if response["drop"] == true {
                continue;
            }
            let location = response["location"]
                .as_str()
                .map(|v| format!("Location: {v}\r\n"))
                .unwrap_or_default();
            let body = response["wireHex"]
                .as_str()
                .map(|s| hex::decode(s).unwrap())
                .unwrap_or_else(|| response["body"].as_str().unwrap().as_bytes().to_vec());
            let encoding = response["encoding"]
                .as_str()
                .map(|v| format!("Content-Encoding: {v}\r\n"))
                .unwrap_or_default();
            let reply = format!(
                "HTTP/1.1 {} Fixture\r\n{location}{encoding}Content-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response["status"],
                response["type"].as_str().unwrap(),
                body.len() + if response["truncated"] == true { 64 } else { 0 }
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        }
    });
    let base = input["base"]
        .as_str()
        .unwrap_or("http://HOST")
        .replace("HOST", &addr.to_string());
    let index = input["index"].as_str();
    let env = |k: &str| input["env"][k].as_str().map(str::to_owned);
    let result = match input["service"].as_str().unwrap() {
        "open" => match OpenSearchConfig::from_env_lookup(|k| {
            if k == "OPENSEARCH_URL" {
                Some(base.clone())
            } else {
                env(k)
            }
        }) {
            Err(e) => Err(e),
            Ok(config) => {
                let client = OpenSearchClient::new(config);
                match input["op"].as_str() {
                    Some("getMapping") => client
                        .get_mapping(index.unwrap())
                        .await
                        .map(|v| v.unwrap_or(Value::Null)),
                    Some("putMapping") => client
                        .put_mapping(index.unwrap(), &json!({"title":{"type":"keyword"}}))
                        .await
                        .map(|_| Value::Null),
                    _ => {
                        client
                            .search(index, &json!({"query":{"match_all":{}},"min_score":1e-7}))
                            .await
                    }
                }
            }
        },
        "meili" => {
            let client = MeilisearchClient::new(MeilisearchConfig::from_env_lookup(|k| {
                if k == "MEILISEARCH_INSTANCE" {
                    Some(base.clone())
                } else {
                    env(k)
                }
            }));
            if input["multi"] == true {
                client.multi_search(&json!({"queries":[]})).await
            } else {
                client
                    .search(index.unwrap_or("offers"), &json!({"q":"co-op ★","limit":7}))
                    .await
            }
        }
        "vector" => match VectorizeConfig::from_env_lookup(|key| match key {
            "CLOUDFLARE_ACCOUNT_ID" => env(key).or_else(|| Some("account".into())),
            "CLOUDFLARE_API_TOKEN" => env(key).or_else(|| Some("fixture".into())),
            _ => index.map(str::to_owned),
        }) {
            Err(e) => Err(e),
            Ok(config) => {
                let client = VectorizeClient::new(VectorizeConfig {
                    api_base: format!("{base}/client/v4"),
                    timeout_ms: 5000,
                    ..config
                })
                .unwrap();
                client
                    .query_offers_with_natural_language("co-op ★", 7)
                    .await
                    .map(|values| {
                        serde_json::from_str(&egdata_core::v1::serialization::node_json(&json!(
                            values
                        )))
                        .unwrap()
                    })
            }
        },
        _ => panic!("unknown fixture"),
    };
    let output = match result {
        Ok(v) => json!({"value":v}),
        Err(SearchClientError::VectorizeConfiguration(message)) => {
            json!({"message":message,"status":null})
        }
        Err(SearchClientError::UnexpectedResponse(message)) => json!({"typeError":message}),
        Err(SearchClientError::Configuration(message)) => json!({"config":message}),
        Err(SearchClientError::HttpStatus { status, .. }) => json!({"status":status}),
        Err(SearchClientError::Transport(_) | SearchClientError::MeilisearchUrlCredentials) => {
            json!({"transportError":true})
        }
        Err(SearchClientError::MeilisearchHeader) => json!({"invalidHeader":true}),
        Err(SearchClientError::Json(_)) => json!({"invalidJson":true}),
        Err(SearchClientError::Compression(_)) => json!({"compressionError":true}),
        Err(SearchClientError::CloudflareVectorize { message, status }) => {
            json!({"message":message,"status":status})
        }
    };
    server.abort();
    let seen = requests.lock().unwrap().clone();
    (output, seen)
}
#[tokio::test]
async fn real_http_search_clients_match_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/search-clients-loopback-node.json"
    ))
    .unwrap();
    let mut differences = Vec::new();
    for case in cases {
        let (output, requests) = replay(&case).await;
        if output != case["output"] || requests != *case["requests"].as_array().unwrap() {
            differences.push(format!(
                "{}: output={output}; requests={}",
                case["name"],
                json!(requests)
            ));
        }
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[tokio::test]
#[ignore = "requires disposable authenticated OpenSearch"]
async fn native_opensearch_mapping_search_after_and_auth_match_node() {
    let base = std::env::var("EGDATA_TEST_OPENSEARCH").unwrap();
    assert_eq!(
        url::Url::parse(&base).unwrap().host_str(),
        Some("127.0.0.1")
    );
    let base = base.trim_end_matches('/');
    let index = format!("egdata-transport-{}", uuid::Uuid::new_v4());
    let password = "Fixture-Only-Search-42!";
    let http = reqwest::Client::new();
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/search-clients-cluster-node.json"
    ))
    .unwrap();
    let expected = &fixture[0];
    let setup = &expected["setup"];
    let url = format!("{base}/{index}");
    http.put(&url)
        .basic_auth("admin", Some(password))
        .json(&json!({"settings":{"number_of_shards":1,"number_of_replicas":0}}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let observed = cluster_reads(base, &index, setup, &http, password).await;
    http.delete(&url)
        .basic_auth("admin", Some(password))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(observed.unwrap(), *expected);
}

async fn cluster_reads(
    base: &str,
    index: &str,
    setup: &Value,
    http: &reqwest::Client,
    password: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    let url = format!("{base}/{index}");
    let config = |password: &str| OpenSearchConfig {
        node: base.into(),
        username: Some("admin".into()),
        password: Some(password.into()),
    };
    let client = OpenSearchClient::new(config(password));
    client.put_mapping(index, &setup["mapping"]).await?;
    for doc in setup["documents"].as_array().unwrap() {
        http.put(format!(
            "{url}/_doc/{}?refresh=true",
            doc["id"].as_str().unwrap()
        ))
        .basic_auth("admin", Some(password))
        .json(&json!({"rank":doc["rank"]}))
        .send()
        .await?
        .error_for_status()?;
    }
    let mapped = client.get_mapping(index).await?;
    let mut query = setup["query"].clone();
    let mut pages = Vec::new();
    for _ in 0..2 {
        let response = client.search(Some(index), &query).await?;
        let result = &response["hits"];
        let rows = result["hits"].as_array().ok_or("missing hits")?;
        let hits = rows
            .iter()
            .map(|h| json!({"id":h["_id"],"source":h["_source"],"sort":h["sort"]}))
            .collect::<Vec<_>>();
        pages.push(json!({"total":result["total"],"hits":hits}));
        query["search_after"] = rows.first().ok_or("missing hit")?["sort"].clone();
    }
    fn status(result: Result<Value, SearchClientError>) -> Result<u16, SearchClientError> {
        match result {
            Ok(_) => Ok(200),
            Err(SearchClientError::HttpStatus { status, .. }) => Ok(status),
            Err(e) => Err(e),
        }
    }
    let missing = status(
        client
            .search(Some(&format!("{index}-missing")), &query)
            .await,
    )?;
    let invalid = status(
        client
            .search(
                Some(index),
                &json!({"query":{"unsupported_fixture_query":{}}}),
            )
            .await,
    )?;
    let denied = OpenSearchClient::new(config("Invalid-Fixture-Credential"));
    let unauthenticated = status(denied.search(Some(index), &query).await)?;
    Ok(
        json!({"setup":setup,"mapped":mapped,"pages":pages,"missing":missing,"invalidQuery":invalid,"unauthenticated":unauthenticated}),
    )
}

#[tokio::test]
async fn explicit_client_configuration_fails_before_an_http_request() {
    let open = OpenSearchClient::new(OpenSearchConfig {
        node: "not a url".into(),
        username: None,
        password: None,
    });
    assert_eq!(
        open.search(Some("offers"), &json!({}))
            .await
            .unwrap_err()
            .to_string(),
        "Invalid URL"
    );
    let meili = MeilisearchClient::new(MeilisearchConfig {
        host: "mailto:fixture".into(),
        api_key: String::new(),
    });
    assert_eq!(
        meili
            .multi_search(&json!({"queries":[]}))
            .await
            .unwrap_err()
            .to_string(),
        "The provided host is not valid"
    );
}
