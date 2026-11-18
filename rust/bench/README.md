# Compare origin CPU and memory

## Measured on November 18, 2026

On a Windows 11 desktop with a Ryzen 9 7900X3D and 62.9 GiB of visible RAM, each origin ran on the same two logical CPUs. Node 22.17.0 and the Rust 1.95.0 release build served **33,680 measured requests** in total. All four workloads returned matching decoded body bytes across origins and used gzip. The numbers below are medians of four trials per origin.

| Workload | CPU ms/request, Node → Rust | CPU reduction | Requests/s, Node → Rust | p95 latency ms, Node → Rust |
| --- | ---: | ---: | ---: | ---: |
| Countries, paced at 250/s | 1.177 → 0.146 | 88% | 249.9 → 249.7 | 5.65 → 0.95 |
| Countries, burst at 8 concurrent | 0.522 → 0.113 | 78% | 1,967 → 9,473 | 6.47 → 1.12 |
| Search, warm Redis cache, 20/s | 3.516 → 1.367 | 61% | 20.0 → 20.0 | 47.04 → 47.95 |
| GraphQL item, MongoDB, 15/s | 2.344 → 0.694 | 70% | 15.0 → 15.0 | 51.17 → 47.70 |

| Resident memory | Node | Rust |
| --- | ---: | ---: |
| Idle after startup | 160.1 MiB | 37.3 MiB |
| Highest sampled during the run | 316.2 MiB | 41.8 MiB |
| Idle five seconds after load | 171.1 MiB | 41.7 MiB |

The largest latency improvement was on the static JSON route. The two service-backed routes saw lower process CPU per request and similar network-bound latency. This short run used one process per implementation. The Node bundle loads the full legacy route set, and the Rust origin is still being migrated. VM sizing also depends on its OS, traffic mix, sustained concurrency, service latency and workload outside the API processes. The raw report contains the build hashes, CPU affinity, memory samples summarized per trial and timing spread. [Download the observed trials](2026-11-18-windows.json).

## Reproduce the measurement

The Linux launch was also exercised on Ubuntu under WSL2 with disposable MongoDB, Redis, Postgres and authenticated OpenSearch. The fixture contained one public catalog item and two Fortnite search hits. Each CPU configuration completed one round of 8,420 measured requests, with matching response bytes and gzip encoding for every workload. The tests used Node 22.17.0 and the locally packaged `egdata-rust-origin:regional-offers` image (`sha256:0be2901da3ae617eae144ec94fc7d0ed37e335cef2e599dfb19633be525bc91c`). These single-round desktop runs establish Linux launch readiness. The deployment VM and its staging dataset still need their own measurement. [One-CPU fixture results](2026-11-18-linux-fixture-1cpu.json) · [Two-CPU fixture results](2026-11-18-linux-fixture-2cpu.json).

The benchmark launches two private loopback listeners on ports 4400 and 4401. It loads the complete Hono application from a production Rslib bundle and the Rust origin from a Cargo release build. Both origins use the same MongoDB, Redis and OpenSearch settings and a temporary shared Redis cache prefix. The loopback launch skips index provisioning. Rate limiting and anonymous abuse monitoring are disabled for the workload.

From the project root, with the repository dependencies and the Python packages `aiohttp` and `psutil` installed, run:

```sh
pnpm exec rslib build --config rust/bench/rslib.config.mjs
(cd rust && cargo build --release --locked -p egdata-api --bin egdata-api)
python rust/bench/resources.py --env-file "/path/to/egdata-api/.env"
```

On PowerShell, run the Cargo command from the `rust` directory. The runner uses Cargo's configured target directory. To benchmark a packaged release, pass `--rust-binary /path/to/egdata-api`. The default report is `rust/target/resource-benchmark.json`.

The runner uses up to two allowed logical CPUs on Linux and Windows. Use `--cpus 1` to pin each origin to one CPU. On Linux the affinity mask is in place before Node or Tokio creates worker threads. Use the same cgroup CPU quota and memory limit as the staging origin when benchmarking a containerized VM.

Use a staging catalog with at least one public item and populated search results for Fortnite. Both origins need the same service credentials. Redis needs write access to the temporary response-cache namespace. For a quick launch and response check, pass `--rounds 1 --out /path/to/smoke.json`. The standard run uses four alternating rounds.

## Workloads and measurements

Each origin receives the same request count in four rounds with alternating order. Every trial warms the connection pool and endpoint first. Clients request gzip and reuse HTTP connections. The runner validates equal JSON for the two implementations and checks every response against the corresponding origin's preflight body digest and content encoding. Search uses a primed Redis result for a two-hit Fortnite query. GraphQL reads one populated public catalog item directly from MongoDB. The countries endpoint exercises the HTTP stack, serialization, ETags and compression at a fixed rate and in a closed-loop burst.

CPU is the change in the origin process's user plus kernel CPU time divided by completed requests. It excludes the load generator and remote services. RSS is the resident working set of the process, sampled every 100 ms during each trial. Startup idle RSS follows a successful health check and three seconds at rest. Post-load idle RSS is sampled five seconds after the last request. Latency runs from request dispatch until the client receives the full decoded body. Burst throughput includes any load-generator or loopback bottleneck.
