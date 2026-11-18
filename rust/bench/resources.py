"""Benchmark the real Node and Rust HTTP origins on loopback. Requires aiohttp and psutil."""
import argparse
import asyncio
from contextlib import ExitStack
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import secrets
import shutil
import statistics
import subprocess
import time
from urllib.parse import urlencode

import aiohttp
import psutil


ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "rust" / "target"
MIB = 1024**2
PORTS = {"Node": 4400, "Rust": 4401}


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def memory(process):
    info = process.memory_info()
    return info.rss / MIB


def cpu(process):
    times = process.cpu_times()
    return times.user + times.system


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def launch(label, env_file, env, cpus, stack, binary):
    if label == "Node":
        module = (TARGET / "resource-benchmark-node" / "origin.js").as_uri()
        code = (
            "import path from 'node:path';"
            "for (const k of ['MONGO_CA','MONGO_CERT']) "
            "if (process.env[k]) process.env[k]=path.resolve(process.env.BENCH_ENV_DIR,process.env[k]);"
            f"const origin=await import({json.dumps(module)});await origin.listen({PORTS[label]});"
        )
        command = ["node", f"--env-file={env_file}", "--enable-source-maps", "--input-type=module", "-e", code]
    else:
        command = [str(binary), "--env-file", str(env_file), "--bind", "127.0.0.1", "--port", str(PORTS[label])]
    # Linux affinity is per thread. Set the launching thread's mask first so
    # workers created during Node and Tokio initialization inherit the same CPUs.
    with ExitStack() as restore:
        if hasattr(os, "sched_setaffinity"):
            previous = os.sched_getaffinity(0)
            os.sched_setaffinity(0, cpus)
            restore.callback(os.sched_setaffinity, 0, previous)
        child = psutil.Popen(command, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stack.callback(stop, child)
        if not hasattr(os, "sched_setaffinity"):
            child.cpu_affinity(cpus)
    return child


def rust_binary(override):
    if override:
        return override.resolve(strict=True)
    target = TARGET
    if shutil.which("cargo"):
        metadata = subprocess.check_output(
            ["cargo", "metadata", "--no-deps", "--locked", "--format-version", "1"],
            cwd=ROOT / "rust", text=True,
        )
        target = Path(json.loads(metadata)["target_directory"])
    if triple := os.environ.get("CARGO_BUILD_TARGET"):
        target /= triple
    path = target / "release" / ("egdata-api.exe" if os.name == "nt" else "egdata-api")
    if not path.is_file():
        raise FileNotFoundError(f"Missing Rust release executable at {path}. Use --rust-binary for a packaged build.")
    return path


async def get(session, origin, path):
    async with session.get(f"http://127.0.0.1:{PORTS[origin]}{path}", allow_redirects=False) as response:
        data = await response.read()
        if response.status != 200:
            raise RuntimeError(f"{origin} returned HTTP {response.status} for {path.split('?')[0]}")
        return data, response.headers.get("Content-Encoding", "identity")


async def ready(session, origin, child):
    for _ in range(180):
        if child.poll() is not None:
            raise RuntimeError(f"{origin} exited during startup, code {child.returncode}")
        try:
            body, _ = await get(session, origin, "/v1/health")
            if json.loads(body)["data"]["status"] == "ok":
                return
        except (aiohttp.ClientError, TimeoutError):
            pass
        await asyncio.sleep(0.25)
    raise RuntimeError(f"{origin} did not become healthy")


async def trial(session, origin, process, path, expected, count, concurrency, rate):
    # Keep one closed-loop worker per connection. For a fixed rate, each request
    # has an absolute release time; delivered throughput is reported separately.
    latencies, memory_samples = [], [memory(process)]
    jobs = iter(range(count))
    start_cpu = cpu(process)
    start = time.perf_counter()

    async def worker():
        for index in jobs:
            if rate:
                await asyncio.sleep(max(0, start + index / rate - time.perf_counter()))
            t = time.perf_counter()
            body, encoding = await get(session, origin, path)
            latencies.append(1000 * (time.perf_counter() - t))
            if hashlib.sha256(body).digest() != expected[0] or encoding != expected[1]:
                raise RuntimeError(f"{origin} response changed during {path.split('?')[0]}")

    async def sample():
        while True:
            await asyncio.sleep(0.1)
            memory_samples.append(memory(process))

    monitor = asyncio.create_task(sample())
    try:
        await asyncio.gather(*(worker() for _ in range(concurrency)))
    finally:
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)
    elapsed = time.perf_counter() - start
    used = cpu(process) - start_cpu
    memory_samples.append(memory(process))
    latencies.sort()
    return {
        "requests": count, "seconds": elapsed, "serverCpuSeconds": used,
        "cpuMsPerRequest": used * 1000 / count, "meanCpuCores": used / elapsed,
        "requestsPerSecond": count / elapsed, "p50Ms": statistics.median(latencies),
        "p95Ms": latencies[math.ceil(0.95 * count)-1],
        "peakRssMiB": max(memory_samples), "endRssMiB": memory_samples[-1],
    }


async def run(args):
    env_file = args.env_file.resolve(strict=True)
    allowed = psutil.Process().cpu_affinity()
    count = min(2, len(allowed)) if args.cpus is None else args.cpus
    if not 1 <= count <= len(allowed):
        raise ValueError(f"--cpus must be between 1 and {len(allowed)} on this host")
    cpus = (allowed[::2] + allowed[1::2])[:count]
    binary = rust_binary(args.rust_binary)
    token = secrets.token_hex(32)
    env = dict(os.environ, BENCH_ENV_DIR=str(env_file.parent), NODE_ENV="production",
               LOG_LEVEL="-999", RUST_LOG="error", RATE_LIMIT_ENABLED="false", ANTI_ABUSE_MODE="off",
               ORIGIN_AUTH_TOKEN=token, V1_WORKER_TOKEN=token, V1_CURSOR_SECRET=token,
               RESPONSE_CACHE_PREFIX="rust:bench:"+secrets.token_hex(8)+":", TOKIO_WORKER_THREADS=str(len(cpus)))
    headers = {"accept-encoding":"gzip", "x-request-id":"req_resource_benchmark",
               "x-egdata-origin-token":token, "x-egdata-worker-token":token,
               "x-egdata-key-id":"key_benchmark", "x-egdata-key-tier":"free"}
    runs = []
    result = {
        "date": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "os": platform.platform(),
        "logicalCpus": psutil.cpu_count(), "hostMemoryGiB": psutil.virtual_memory().total / 1024**3,
        "originAffinity": cpus, "node": subprocess.check_output(["node","--version"],text=True).strip(),
        "nodeBundleSha256":fingerprint(TARGET / "resource-benchmark-node" / "origin.js"),
        "rustBinarySha256":fingerprint(binary), "rounds":args.rounds, "workloads":{}, "trials":runs,
    }
    async with aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=25)) as session:
        with ExitStack() as stack:
            # Refuse an occupied benchmark port before attaching counters to a PID.
            import socket
            for port in PORTS.values():
                with socket.socket() as listener:
                    # A completed Linux run can leave connections in TIME_WAIT.
                    # Active listeners still prevent this bind.
                    if os.name != "nt":
                        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    listener.bind(("127.0.0.1", port))
            children = {name: launch(name, env_file, env, cpus, stack, binary) for name in PORTS}
            await asyncio.gather(*(ready(session, name, p) for name,p in children.items()))
            await asyncio.sleep(3)
            result["idleAfterStartupMiB"] = {n:memory(p) for n,p in children.items()}
            items, _ = await get(session, "Node", "/v1/items?limit=1")
            item = json.loads(items)["data"][0]["id"]
            query = urlencode({"query":"query Item($id:ID!){item(id:$id){id title namespace}}",
                               "variables":json.dumps({"id":item}, separators=(",",":"))})
            workloads = [
                ("countries-paced", "/v1/countries", 1500, 8, 250),
                ("countries-burst", "/v1/countries", 2500, 8, 0),
                ("search-warm-cache", "/v1/search?title=Fortnite&limit=2", 120, 4, 20),
                ("graphql-item-mongo", "/graphql?"+query, 90, 4, 15),
            ]
            for label,path,count,concurrency,rate in workloads:
                expected = {}
                reference = None
                for name in PORTS:
                    body, encoding = await get(session,name,path)
                    value = json.loads(body)
                    if "errors" in value or not value.get("data"):
                        raise RuntimeError(f"{name} returned empty or erroneous data for {label}")
                    if label == "graphql-item-mongo" and value["data"]["item"]["id"] != item:
                        raise RuntimeError("Mongo query did not return the requested item")
                    if reference is not None and value != reference:
                        raise RuntimeError(f"Node/Rust JSON differs for {label}")
                    reference = value
                    expected[name] = (hashlib.sha256(body).digest(),encoding)
                result["workloads"][label] = {"path":path.split("?")[0],"requestsPerTrial":count,
                    "concurrency":concurrency,"offeredRps":rate or None,
                    "encoding":{n:v[1] for n,v in expected.items()},
                    "sameBodyBytes":expected["Node"][0] == expected["Rust"][0]}
                print(f"Verified {label}; starting {args.rounds} alternating rounds",flush=True)
                for round_index in range(args.rounds):
                    order=list(PORTS) if round_index % 2 == 0 else list(reversed(PORTS))
                    for name in order:
                        # Warm each path and connection pool before taking CPU deltas.
                        await trial(session,name,children[name],path,expected[name],
                                    60 if label.startswith("countries") else 8,concurrency,rate)
                        sample=await trial(session,name,children[name],path,expected[name],count,concurrency,rate)
                        runs.append(dict(origin=name,workload=label,round=round_index+1,**sample))
            await asyncio.sleep(5)
            result["idleAfterLoadMiB"]={n:memory(p) for n,p in children.items()}
    args.out.write_text(json.dumps(result,indent=2)+"\n", encoding="utf-8")
    for label in result["workloads"]:
        for name in PORTS:
            samples=[r for r in runs if r["workload"] == label and r["origin"] == name]
            print(label,name,{k:round(statistics.median(s[k] for s in samples),3)
                for k in ["cpuMsPerRequest","requestsPerSecond","p95Ms","peakRssMiB"]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--rust-binary", type=Path, help="exact release executable to benchmark")
    parser.add_argument("--cpus", type=int, help="logical CPUs per origin (default: up to two allowed CPUs)")
    parser.add_argument("--rounds", type=int, choices=range(1,11), default=4)
    parser.add_argument("--out", type=Path, default=TARGET / "resource-benchmark.json")
    asyncio.run(run(parser.parse_args()))
