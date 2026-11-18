use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    process::Command,
    thread,
};

// The release gate depends on the binary's exit status as well as its printed report.
#[test]
fn executable_reports_matching_and_different_responses() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for _ in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let body = if line.contains("/changed/") {
                "changed"
            } else {
                "original"
            };
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let case = std::env::temp_dir().join(format!("egdata-diff-cli-{}.json", std::process::id()));
    std::fs::write(
        &case,
        r#"[{"name":"probe","method":"GET","path":"/probe"}]"#,
    )
    .unwrap();
    for (suffix, success, summary) in [("", true, "1/1 passed"), ("/changed", false, "0/1 passed")]
    {
        let result = Command::new(env!("CARGO_BIN_EXE_egdata-diff"))
            .args([
                "--node-url",
                &url,
                "--rust-url",
                &format!("{url}{suffix}"),
                "--fixtures",
            ])
            .arg(&case)
            .output()
            .unwrap();
        assert_eq!(result.status.success(), success, "{result:?}");
        assert!(String::from_utf8(result.stdout).unwrap().contains(summary));
    }
    server.join().unwrap();
    std::fs::remove_file(case).unwrap();
    let invalid = Command::new(env!("CARGO_BIN_EXE_egdata-diff"))
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert!(
        String::from_utf8(invalid.stderr)
            .unwrap()
            .contains("no diff cases loaded")
    );
}
