//! Exercise the public administrative binary and the original Node CLI with disposable services.
use std::path::Path;
use std::process::{Command, Output};

use chrono::{DateTime, Utc};
use egdata_infra::redis_store::SUMMARY_PREFIX;
use redis::AsyncCommands;
use serde_json::{Value, json};

#[test]
fn contract_binary_checks_the_documents_and_reports_invalid_invocations() {
    let binary = env!("CARGO_BIN_EXE_generate-openapi");
    let result = Command::new(binary)
        .args(["--check", "--require-handlers"])
        .output()
        .unwrap();
    assert!(result.status.success(), "{result:?}");
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("155/155")
    );
    let invalid = Command::new(binary).arg("--unknown-flag").output().unwrap();
    assert!(!invalid.status.success());
    assert!(
        String::from_utf8(invalid.stderr)
            .unwrap()
            .contains("--unknown-flag")
    );
}

fn cli(node: bool, args: &[&str]) -> Output {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let cert = std::env::var("EGDATA_TEST_MONGO_CERT").unwrap();
    let redis = url::Url::parse(&std::env::var("EGDATA_TEST_REDIS").unwrap()).unwrap();
    assert_eq!(redis.host_str(), Some("127.0.0.1"));
    let mut command = if node {
        let mut cmd = Command::new("node");
        cmd.arg(root.join("node_modules/tsx/dist/cli.mjs"))
            .arg(root.join("scripts/anti-abuse-ops.ts"));
        cmd
    } else {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_egdata-api"));
        cmd.arg("anti-abuse-ops");
        cmd
    };
    command.env_clear();
    for key in [
        "PATH",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "LLVM_PROFILE_FILE",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .current_dir(Path::new(&cert).parent().unwrap())
        .env("ANTI_ABUSE_MODE", "observe")
        .env("ANTI_ABUSE_REDIS_HOST", redis.host_str().unwrap())
        .env("ANTI_ABUSE_REDIS_PORT", redis.port().unwrap().to_string())
        .args(args)
        .output()
        .unwrap()
}

fn output(node: bool, args: &[&str]) -> Value {
    let result = cli(node, args);
    assert!(
        result.status.success(),
        "CLI failed for {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}

fn compare(args: &[&str]) -> Value {
    let mut node = output(true, args);
    let mut rust = output(false, args);
    // Each invocation samples its own clock; verify both timestamps before comparison.
    for result in [&mut node, &mut rust] {
        if let Some(time) = result.as_object_mut().unwrap().remove("observedAt") {
            let instant = DateTime::parse_from_rfc3339(time.as_str().unwrap()).unwrap();
            assert!((Utc::now() - instant.to_utc()).num_seconds().abs() < 30);
        }
    }
    assert_eq!(rust, node, "{args:?}");
    rust
}

#[tokio::test]
#[ignore = "requires the disposable Redis stack and the Node oracle"]
async fn administrative_commands_match_node_on_shared_redis() {
    let url = std::env::var("EGDATA_TEST_REDIS").unwrap();
    let mut conn = redis::Client::open(url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap();
    // Use the previous complete minute so both commands straddle minute boundaries safely.
    let bucket = Utc::now().timestamp() / 60 - 1;
    let _: () = conn
        .hset_multiple(
            format!("{SUMMARY_PREFIX}{bucket}"),
            &[
                ("observe|GET|z-last|200|requests", 2),
                ("observe|GET|a-first|200|requests", 1),
                ("observe|GET|z-last|200|bodyBytes", 88),
                ("observe|GET|a-first|200|bodyBytes", 88),
                ("__duplicate", 1),
            ],
        )
        .await
        .unwrap();
    let report = compare(&["report", "--minutes", "31"]);
    assert_eq!(report["totals"]["requests"], 3);
    assert_eq!(report["routes"][0]["group"], "observe|GET|z-last|200");
    compare(&["cohorts"]);
    assert_eq!(compare(&["status"])["trial"], Value::Null);

    let fingerprint = "f".repeat(64);
    let start = [
        "start-trial",
        "--id",
        "fixture",
        "--fingerprint",
        &fingerprint,
        "--seconds",
        "60",
    ];
    assert_eq!(output(false, &start)["started"], "fixture");
    assert!(!cli(true, &start).status.success());
    assert!(!cli(false, &start).status.success());
    assert_eq!(compare(&["status"])["trial"]["fingerprints"], 1);
    assert_eq!(
        compare(&["stop-trial", "--id", "different"])["stopped"],
        false
    );
    assert_eq!(
        output(true, &["stop-trial", "--id", "fixture"])["stopped"],
        true
    );
    assert_eq!(output(true, &start)["route"], "offer-details");
    assert_eq!(
        output(false, &["stop-trial", "--id", "fixture"])["stopped"],
        true
    );
    assert_eq!(
        compare(&["status"]),
        json!({"mode":"observe","canaries":false,"trial":null})
    );
}
