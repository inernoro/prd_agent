#!/usr/bin/env python3
"""只读采集控制面连续窗口；凭据由同仓库 cdscli 加载，不保存响应正文。"""
from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as dt
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from urllib.parse import urlsplit

ENDPOINTS = {
    "branches": "/api/branches?widget=1",
    "runs": "/api/deployment-runs?limit=50",
    "health": "/healthz?lightweight=1",
}
DIAGNOSTICS = "/api/cds-system/diagnostics/main-thread"
VERSION = "/api/self-status"
MARKER = "\n__CDS_WINDOW_META__"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def nearest_rank(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def valid_body(name: str, body: object) -> bool:
    if not isinstance(body, dict):
        return False
    if name == "health":
        return body.get("ok") is True
    if name in ("branches", "runs"):
        return isinstance(body.get(name), list)
    if name == "diagnostics":
        return isinstance(body.get("eventLoop"), dict) and isinstance(body.get("mainThread"), dict)
    return bool(body.get("headSha")) and bool(body.get("runningPid"))


def classify(name: str, status: int, exit_code: int, mime: str, body: object) -> str | None:
    if exit_code:
        return "timeout" if exit_code == 28 else "transport_error"
    if status != 200:
        return "http_error"
    if "json" not in mime.lower() or not valid_body(name, body):
        return "invalid_response"
    return None


def latency_summary(records: list[dict], required_samples: int) -> dict:
    values = [r["elapsedMs"] for r in records]
    errors = sum(r.get("error") is not None for r in records)
    p95, p99 = nearest_rank(values, .95), nearest_rank(values, .99)
    complete = len(records) >= required_samples
    return {
        "samples": len(records), "requiredSamples": required_samples,
        "errors": errors, "over5s": sum(v > 5000 for v in values),
        "p50Ms": nearest_rank(values, .5), "p95Ms": p95, "p99Ms": p99,
        "maxMs": max(values) if values else None,
        "coverageComplete": complete,
        "latencyTargetMet": bool(complete and values and not errors and max(values) <= 5000
                                 and p95 <= 1000 and p99 <= 2000),
    }


def active_projects(body: dict) -> list[str]:
    return sorted({r["projectId"] for r in body.get("runs", [])
                   if isinstance(r, dict) and r.get("projectId") and not r.get("finishedAt")
                   and r.get("status") in {"queued", "building", "starting", "verifying", "running"}})


def version_fingerprint(body: dict) -> dict:
    return {k: body.get(k) for k in ("headSha", "webBuildSha", "runningPid", "pidStartedAt")}


def diagnostic_snapshot(body: dict) -> dict:
    mt = body.get("mainThread", {})
    previous = mt.get("previous") or {}
    # Only completed windows count. Never substitute the current partial minute.
    return {
        "generatedAt": body.get("generatedAt"),
        "eventLoopWindowStartedAt": body.get("eventLoop", {}).get("windowStartedAt"),
        "eventLoopPrevious": body.get("eventLoop", {}).get("previous"),
        "mainThreadPrevious": {k: previous.get(k) for k in ("startedAt", "durationMs", "sections", "gc", "sse")},
        "sseOpen": mt.get("sseOpen"),
        "process": {k: body.get("process", {}).get(k) for k in ("pid", "rssMB", "heapUsedMB")},
    }


def header_config(headers: dict[str, str]) -> str:
    lines = []
    for key, value in headers.items():
        if any(c in key + value for c in "\r\n"):
            raise ValueError("invalid header")
        escaped = (key + ": " + value).replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'header = "{escaped}"')
    return "\n".join(lines) + "\n"


def curl_timings(meta: dict) -> dict:
    """累计阶段计时用于定位链路；首字节等待仍含网络，不能直接当作服务端耗时。"""
    result = {}
    for field, label in (("time_namelookup", "dnsCompletedMs"),
                         ("time_connect", "tcpConnectedMs"),
                         ("time_appconnect", "tlsConnectedMs"),
                         ("time_pretransfer", "transferReadyMs"),
                         ("time_starttransfer", "firstByteMs"),
                         ("time_total", "curlTotalMs")):
        value = meta.get(field)
        result[label] = (round(value * 1000, 3)
                         if isinstance(value, (int, float)) and not isinstance(value, bool)
                         and math.isfinite(value) and value >= 0 else None)
    return result


def append_evidence(stream, value: object) -> None:
    stream.write(json.dumps(value, ensure_ascii=False) + "\n")
    stream.flush()


class Probe:
    def __init__(self, base: str, headers: dict[str, str], timeout: int):
        parsed = urlsplit(base)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("invalid CDS host")
        self.base, self.config, self.timeout = base.rstrip("/"), header_config(headers), timeout

    def request(self, name: str, path: str) -> tuple[dict, object]:
        started_at, start = utc_now(), time.monotonic()
        meta = {}
        cmd = ["curl", "--disable", "--silent", "--show-error", "--max-time", str(self.timeout),
               "--max-filesize", "10485760", "--proto", "=http,https", "--config", "-",
               "--write-out", MARKER + "%{json}", self.base + path]
        try:
            proc = subprocess.run(cmd, input=self.config, capture_output=True, text=True,
                                  timeout=self.timeout + 5, check=False)
            raw, sep, metadata = proc.stdout.rpartition(MARKER)
            meta = json.loads(metadata) if sep else {}
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            status, mime = int(meta.get("http_code", 0)), meta.get("content_type") or ""
            code = proc.returncode
        except subprocess.TimeoutExpired:
            body, status, mime, code = None, 0, "", 28
        except (OSError, ValueError):
            body, status, mime, code = None, 0, "", 1
        record = {"at": started_at, "name": name, "path": path, "status": status,
                  "elapsedMs": round((time.monotonic() - start) * 1000, 1),
                  "curlExitCode": code, "contentType": mime,
                  "timings": curl_timings(meta),
                  "error": classify(name, status, code, mime, body)}
        return record, body


def write_json(path: Path, value: object) -> None:
    with path.open("w", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration-seconds", type=int, default=1800)
    parser.add_argument("--interval-seconds", type=int, default=10)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    args = parser.parse_args()
    if min(args.duration_seconds, args.interval_seconds, args.timeout_seconds) <= 0:
        parser.error("duration, interval and timeout must be positive")
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("output directory must be empty")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(args.output, 0o700)
    cli_path = Path(__file__).resolve().parents[2] / ".claude/skills/cds/cli/cdscli.py"
    spec = importlib.util.spec_from_file_location("cdscli_window", cli_path)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    cli._load_local_credentials()
    probe = Probe(cli._cds_base(), {"Accept": "application/json", **cli._auth_headers()}, args.timeout_seconds)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    metadata = {"startedAt": utc_now(), "status": "running", "host": probe.base,
                "evidenceSchemaVersion": 2,
                "collectorPid": os.getpid(),
                "durationSeconds": args.duration_seconds, "intervalSeconds": args.interval_seconds,
                "timeoutSeconds": args.timeout_seconds, "endpoints": ENDPOINTS,
                "scope": "read-only diagnostic window, not independent final acceptance",
                "percentileMethod": "nearest-rank; include errors and timeouts"}
    write_json(args.output / "metadata.json", metadata)
    start_record, start_body = probe.request("version", VERSION)
    versions = {"start": {"request": start_record, "fingerprint": version_fingerprint(start_body) if isinstance(start_body, dict) else None}}
    write_json(args.output / "versions.json", versions)
    records, diagnostics, loads = [], [], []
    start = time.monotonic()
    metadata["windowStartedAt"] = utc_now()
    write_json(args.output / "metadata.json", metadata)
    next_round, next_diag, skipped = 0.0, 0.0, 0
    with contextlib.ExitStack() as stack:
        streams = {}
        for name in ("requests", "diagnostics", "workload"):
            path = args.output / (name + ".jsonl")
            streams[name] = stack.enter_context(path.open("w", encoding="utf-8"))
            os.chmod(path, 0o600)
        stream = streams["requests"]
        pool = stack.enter_context(concurrent.futures.ThreadPoolExecutor(max_workers=4))
        while not stop.is_set() and time.monotonic() - start < args.duration_seconds:
            if stop.wait(max(0, next_round - (time.monotonic() - start))):
                break
            if time.monotonic() - start >= args.duration_seconds:
                break
            tasks = {name: pool.submit(probe.request, name, path) for name, path in ENDPOINTS.items()}
            if time.monotonic() - start >= next_diag:
                tasks["diagnostics"] = pool.submit(probe.request, "diagnostics", DIAGNOSTICS)
                next_diag += 60
            for name, task in tasks.items():
                record, body = task.result()
                records.append(record)
                append_evidence(stream, record)
                if not record["error"] and isinstance(body, dict):
                    if name == "diagnostics":
                        diagnostics.append(diagnostic_snapshot(body))
                        append_evidence(streams["diagnostics"], diagnostics[-1])
                    elif name == "runs":
                        loads.append({"at": record["at"], "observedActiveProjects": active_projects(body),
                                      "returnedRuns": len(body["runs"]), "totalRuns": body.get("total")})
                        append_evidence(streams["workload"], loads[-1])
            next_round += args.interval_seconds
            elapsed = time.monotonic() - start
            if elapsed > next_round + args.interval_seconds:
                missed = math.floor((elapsed - next_round) / args.interval_seconds)
                skipped += missed
                next_round += missed * args.interval_seconds
            metadata.update({"lastSampleAt": utc_now(), "requestRecords": len(records), "skippedIntervals": skipped})
            write_json(args.output / "metadata.json", metadata)
    end_record, end_body = probe.request("version", VERSION)
    versions["end"] = {"request": end_record, "fingerprint": version_fingerprint(end_body) if isinstance(end_body, dict) else None}
    write_json(args.output / "versions.json", versions)
    required = max(180, math.ceil(args.duration_seconds / args.interval_seconds))
    summary = {name: latency_summary([r for r in records if r["name"] == name], required) for name in ENDPOINTS}
    metadata.update({"finishedAt": utc_now(), "status": "interrupted" if stop.is_set() else "complete",
                     "elapsedSeconds": round(time.monotonic() - start, 1), "skippedIntervals": skipped})
    payload = {"metadata": metadata, "latencies": summary, "versions": versions,
               "diagnostics": diagnostics, "workload": loads,
               "observedMultipleProjects": any(len(x["observedActiveProjects"]) >= 2 for x in loads)}
    payload["stableMasterVersion"] = bool(
        not start_record["error"] and not end_record["error"]
        and versions["start"]["fingerprint"] == versions["end"]["fingerprint"]
        and len({d["process"].get("pid") for d in diagnostics}) == 1
        and diagnostics[0]["process"].get("pid") == versions["start"]["fingerprint"]["runningPid"]
    )
    payload["measurementProtocolMatches"] = (
        args.duration_seconds >= 1800 and args.interval_seconds == 10 and args.timeout_seconds == 30
        and not skipped and not stop.is_set()
    )
    # These are evidence prerequisites only, never an independent A01–A12 verdict.
    payload["eligibleForHighLoadComparison"] = bool(
        payload["measurementProtocolMatches"] and payload["stableMasterVersion"]
        and payload["observedMultipleProjects"] and all(x["coverageComplete"] for x in summary.values())
    )
    write_json(args.output / "window.json", payload)
    write_json(args.output / "metadata.json", metadata)
    print(json.dumps({"output": str(args.output), "status": metadata["status"], "latencies": summary}, ensure_ascii=False))
    return 0 if payload["eligibleForHighLoadComparison"] and all(x["latencyTargetMet"] for x in summary.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
