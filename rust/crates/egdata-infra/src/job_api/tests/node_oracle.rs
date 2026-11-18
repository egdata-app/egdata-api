use super::*;
use egdata_core::ports::ProfileRefreshPort;
use serde_json::Map;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;

const ACCOUNT: &str = "example";
const REQUEST_ID: &str = "request_from_test_12345";

#[tokio::test]
async fn signing_and_timeout_boundaries_match_node() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../egdata-api/tests/fixtures/job-boundaries-node.json"
    ))
    .unwrap();
    for case in fixture[0]["signatures"].as_array().unwrap() {
        let result = create_job_api_signature(&JobApiSigningInput {
            key_id: "worker",
            secret: case["secret"].as_str().unwrap(),
            timestamp: "-1",
            nonce: "edge_nonce-123456",
            method: "post",
            url: case["url"].as_str().unwrap(),
            idempotency_key: None,
            body: case["body"].as_str().unwrap().as_bytes(),
        });
        let actual = match result {
            Ok(signature) => json!({"signature":signature}),
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(actual, case["output"]);
    }
    // Keep the local listener open without responding, so only the client's timer can
    // terminate a valid HTTP submission. A separate deadline detects a broken clamp.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    for case in fixture[0]["submissions"].as_array().unwrap() {
        let client = JobApiClient::with_clock(
            JobApiClientConfig {
                base_url: case["baseUrl"]
                    .as_str()
                    .unwrap()
                    .replace("http://jobs.local", &base),
                key_id: "worker".into(),
                secret: "s".repeat(32),
            },
            Client::new(),
            Arc::new(FixedClock {
                now_ms: -1,
                nonce: case["nonce"].as_str().unwrap().into(),
            }),
        );
        let opts = JobApiRequestOptions {
            max_attempts: 1,
            timeout_ms: case["timeoutMs"].as_u64().unwrap(),
            ..Default::default()
        };
        let payload = json!({});
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            client.submit_request(JobApiJobType::OfferRegen, &payload, &opts),
        )
        .await
        .unwrap();
        assert_eq!(
            json!({"error":result.unwrap_err().to_string()}),
            case["output"]
        );
    }
}

fn accepted() -> AcceptedJobApiSubmission {
    let job_id = format!("api-achievement-refresh-{}", "a".repeat(64));
    AcceptedJobApiSubmission {
        workflow_id: job_id.clone(),
        job_id,
        deduplicated: false,
        status_url: "/status/ok".into(),
    }
}

#[async_trait]
impl JobSubmitter for InMemoryCache {
    async fn submit_achievement_refresh(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<AcceptedJobApiSubmission, JobApiError> {
        self.record(json!({"method":"submit","type":"achievement-refresh","payload":{"accountId":account_id},"requestId":request_id})).map_err(|e| JobApiError::RefreshCooldown(e.to_string()))?;
        Ok(accepted())
    }
}

#[tokio::test]
async fn redis_refresh_steps_and_failure_recovery_match_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../egdata-api/tests/fixtures/job-refresh-node.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let initial = case.get("initial").cloned().unwrap_or(json!({}));
        let cache = InMemoryCache {
            kv: Mutex::new(serde_json::from_value(initial).unwrap()),
            fail_at: case["failAt"].as_u64().map(|n| n as usize),
            drop_nx_write: Mutex::new(case["dropSlot"] == true),
            ..Default::default()
        };
        let mut times = case["times"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap());
        let clock = std::cell::RefCell::new(&mut times);
        let result = request_achievement_refresh(
            ACCOUNT,
            case["ttl"].as_i64().unwrap(),
            &cache,
            &cache,
            || clock.borrow_mut().next().unwrap(),
            || REQUEST_ID.into(),
        )
        .await;
        let output = match result {
            Ok(AchievementRefreshRequestResult {
                metadata: Some(metadata),
                reused_cooldown,
            }) => json!({"reusedCooldown":reused_cooldown,"metadata":metadata}),
            Ok(_) => json!({"reusedCooldown":true}),
            Err(e) => json!({"error":e.to_string()}),
        };
        assert_eq!(output, case["output"], "{name}");
        assert_eq!(
            json!(*cache.calls.lock().unwrap()),
            case["calls"],
            "{name} calls"
        );
        assert_eq!(
            json!(*cache.kv.lock().unwrap()),
            case["values"],
            "{name} stored keys"
        );
    }
}

struct AttemptClock(AtomicUsize);
impl JobApiClock for AttemptClock {
    fn now_ms(&self) -> i64 {
        -1
    }
    fn nonce(&self) -> String {
        format!("fixture-attempt-{}", self.0.fetch_add(1, Ordering::Relaxed))
    }
}

pub(super) async fn request_from_socket(socket: &mut TcpStream) -> Value {
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    let req: Vec<_> = line.split_whitespace().collect();
    let (method, path) = (req[0].to_string(), req[1].to_string());
    let mut len = 0;
    let mut headers = Map::new();
    loop {
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        if line == "\r\n" {
            break;
        }
        let (key, value) = line.trim_end().split_once(':').unwrap();
        let key = key.to_ascii_lowercase();
        if key == "content-length" {
            len = value.trim().parse().unwrap();
        }
        if key.starts_with("x-api-") || key == "idempotency-key" || key == "content-type" {
            headers.insert(key, Value::from(value.trim()));
        }
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).await.unwrap();
    json!({"path":path,"method":method,"headers":headers,"body":String::from_utf8(body).unwrap()})
}

#[tokio::test]
async fn signed_http_attempts_and_retry_errors_match_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../egdata-api/tests/fixtures/job-submit-node.json"
    ))
    .unwrap();
    for case in cases {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let steps = case["responses"].as_array().unwrap().clone();
        let count = steps.len();
        let server = tokio::spawn(async move {
            let mut calls = vec![];
            for step in steps {
                let (mut socket, _) = listener.accept().await.unwrap();
                calls.push(request_from_socket(&mut socket).await);
                let body = step["body"].as_str().unwrap();
                let partial = usize::from(step["partial"] == true);
                let reply = format!(
                    "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    step["status"],
                    body.len() + partial,
                    body
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            calls
        });
        let config = JobApiClientConfig {
            base_url: format!("http://{addr}/prefix"),
            key_id: case["config"]["keyId"].as_str().unwrap().into(),
            secret: case["config"]["secret"].as_str().unwrap().into(),
        };
        let client =
            JobApiClient::with_clock(config, Client::new(), Arc::new(AttemptClock(0.into())));
        let payload = serde_json::from_str(case["payload"].as_str().unwrap()).unwrap();
        let options = JobApiRequestOptions {
            request_id: Some(case["requestId"].as_str().unwrap().into()),
            max_attempts: count,
            timeout_ms: 3000,
            backoff_base_ms: 0,
        };
        let output = match client
            .submit_request(JobApiJobType::AchievementRefresh, &payload, &options)
            .await
        {
            Ok(value) => json!(value),
            Err(JobApiError::Request {
                message,
                retryable,
                status,
            }) => json!({"error":message,"retryable":retryable,"status":status}),
            Err(err) => panic!("unexpected client error {err}"),
        };
        assert_eq!(output, case["output"], "{}", case["name"]);
        let calls = tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(json!(calls), case["calls"], "{}", case["name"]);
    }
}

#[tokio::test]
async fn wired_profile_service_reuses_slot_and_status_after_an_unconfigured_attempt() {
    let cache = Arc::new(InMemoryCache::default());
    let mut service = ProfileRefreshService {
        redis: cache.clone(),
        jobs: None,
    };
    assert!(service.status(ACCOUNT).await.unwrap().is_none());
    let error = service
        .request(ACCOUNT, 60_000)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("Job API is not configured"));
    let slot_key = format!("refresh-achievements:temporal-cooldown:{ACCOUNT}");
    let slot = cache.kv.lock().unwrap()[&slot_key].clone();
    let (base, server) = spawn_job_server(1, |path, body| {
        assert_eq!(path, "/v1/jobs/achievement-refreshes");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"accountId":ACCOUNT})
        );
        (202, json!(accepted()).to_string())
    })
    .await;
    service.jobs = Some(JobApiClient::new(JobApiClientConfig {
        base_url: base,
        key_id: "fixture".into(),
        secret: "fixture".repeat(8),
    }));
    service.request(ACCOUNT, 60_000).await.unwrap();
    server.await.unwrap();
    let metadata = service.status(ACCOUNT).await.unwrap().unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata["timestamp"],
        serde_json::from_str::<Value>(&slot).unwrap()["timestamp"]
    );
    service.jobs = None;
    service.request(ACCOUNT, 60_000).await.unwrap();
    assert_eq!(cache.kv.lock().unwrap()[&slot_key], slot);
    let broken = ProfileRefreshService {
        redis: Arc::new(InMemoryCache {
            fail_at: Some(0),
            ..Default::default()
        }),
        jobs: None,
    };
    assert!(broken.status(ACCOUNT).await.is_err());
}

#[test]
fn environment_validation_matches_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../egdata-api/tests/fixtures/job-config-node.json"
    ))
    .unwrap();
    for case in cases {
        let input = &case["input"];
        let actual = match JobApiClientConfig::from_env_lookup(|key| {
            input[key].as_str().map(str::to_owned)
        }) {
            Ok(config) => {
                json!({"baseUrl":config.base_url, "keyId":config.key_id, "secret":config.secret})
            }
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(actual, case["output"]);
    }
    if let Ok(index) = usize::try_from(MAX_SAFE_INTEGER + 1) {
        assert!(
            create_job_api_idempotency_key(
                JobApiJobType::ItemRegen,
                REQUEST_ID,
                index,
                &Value::Null
            )
            .is_err()
        );
    }
}
