#!/usr/bin/env python3
"""LLM Gateway serving availability and auth probe.

This read-only probe is meant for S5/S6 rollout evidence. It repeatedly checks
/gw/v1/healthz without a key, verifies the reported commit is stable, and checks
that protected endpoints reject unauthenticated access.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def _default_base() -> str:
    raw = os.environ.get("GW_BASE", "").strip().rstrip("/")
    if raw:
        return raw
    try:
        proc = subprocess.run(
            ["python3", ".claude/skills/cds/cli/cdscli.py", "--human", "preview-url"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        root = next((line.strip() for line in proc.stdout.splitlines() if line.startswith("http")), "")
        if root:
            return root.rstrip("/") + "/gw/v1"
    except Exception:
        return ""
    return ""


def _request(base: str, path: str, key: str | None = None) -> tuple[int, str, float]:
    req = urllib.request.Request(base + path, method="GET")
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-serving-probe/1.0")
    if key:
        req.add_header("X-Gateway-Key", key)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            elapsed_ms = (time.monotonic() - started) * 1000
            return resp.status, resp.read().decode("utf-8", "replace"), elapsed_ms
    except urllib.error.HTTPError as exc:
        elapsed_ms = (time.monotonic() - started) * 1000
        return exc.code, exc.read().decode("utf-8", "replace"), elapsed_ms
    except Exception as exc:
        elapsed_ms = (time.monotonic() - started) * 1000
        return 0, f"ERR {exc}", elapsed_ms


def _json(raw: str) -> dict:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    return payload


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((percentile / 100) * (len(ordered) - 1)))))
    return ordered[index]


def _write_json(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def _write_markdown(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Serving Probe Report\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- base: `{cell(report['base'])}`\n")
        fh.write(f"- expectedCommit: `{cell(report.get('expectedCommit') or '')}`\n")
        fh.write(f"- sampleCount: `{cell(report['sampleCount'])}`\n")
        fh.write(f"- intervalSeconds: `{cell(report['intervalSeconds'])}`\n")
        fh.write(f"- p95LatencyMs: `{cell(report['latencyMs']['p95'])}`\n\n")
        fh.write("| sample | status | commit | latencyMs |\n")
        fh.write("|---:|---:|---|---:|\n")
        for sample in report["healthSamples"]:
            fh.write(
                f"| {cell(sample['index'])} | {cell(sample['httpStatus'])} | "
                f"{cell(sample.get('commit') or '')} | {cell(round(sample['latencyMs'], 1))} |\n"
            )
        fh.write("\n| protectedPath | status | expected |\n")
        fh.write("|---|---:|---|\n")
        for item in report["protectedChecks"]:
            fh.write(f"| {cell(item['path'])} | {cell(item['httpStatus'])} | 401 |\n")
        fh.write("\n## Failures\n\n")
        failures = report.get("failures") or []
        if failures:
            for failure in failures:
                fh.write(f"- {failure}\n")
        else:
            fh.write("- none\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway serving availability/auth probe")
    parser.add_argument("--base", default=_default_base(), help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""))
    parser.add_argument("--samples", type=int, default=int(os.environ.get("LLMGW_SERVING_PROBE_SAMPLES", "12")))
    parser.add_argument("--interval", type=float, default=float(os.environ.get("LLMGW_SERVING_PROBE_INTERVAL_SECONDS", "5")))
    parser.add_argument("--protected-path", action="append", default=[],
                        help="protected GET path that must reject missing key; repeatable")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_SERVING_PROBE_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_SERVING_PROBE_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    base = (args.base or "").strip().rstrip("/")
    sample_count = max(1, args.samples)
    interval = max(0, args.interval)
    protected_paths = args.protected_path or [
        "/pools?appCallerCode=report-agent.generate%3A%3Achat&modelType=chat",
        "/shadow-comparisons",
    ]

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail",
        "base": base,
        "expectedCommit": args.expect_commit,
        "sampleCount": sample_count,
        "intervalSeconds": interval,
        "latencyMs": {"p50": 0, "p95": 0, "max": 0},
        "healthSamples": [],
        "protectedChecks": [],
        "failures": [],
    }

    if not base:
        report["failures"].append("missing --base/GW_BASE")
    if not report["failures"]:
        commits: list[str] = []
        latencies: list[float] = []
        for index in range(sample_count):
            code, raw, latency = _request(base, "/healthz")
            sample = {"index": index + 1, "httpStatus": code, "commit": "", "latencyMs": latency, "raw": raw[:200]}
            latencies.append(latency)
            if code != 200:
                report["failures"].append(f"healthz sample {index + 1}/{sample_count} HTTP {code}: {raw[:200]}")
            else:
                try:
                    payload = _json(raw)
                    commit = str(payload.get("commit") or payload.get("Commit") or "")
                    sample["commit"] = commit
                    if commit:
                        commits.append(commit)
                    if args.expect_commit and commit and commit != args.expect_commit:
                        report["failures"].append(
                            f"healthz sample {index + 1}/{sample_count} commit mismatch: actual={commit}, expected={args.expect_commit}"
                        )
                except Exception as exc:
                    report["failures"].append(f"healthz sample {index + 1}/{sample_count} invalid JSON: {exc}")
            report["healthSamples"].append(sample)
            if index < sample_count - 1 and interval > 0:
                time.sleep(interval)

        distinct_commits = sorted(set(commits))
        if len(distinct_commits) > 1:
            report["failures"].append(f"healthz commit drift: {', '.join(distinct_commits)}")
        report["latencyMs"] = {
            "p50": round(_percentile(latencies, 50), 1),
            "p95": round(_percentile(latencies, 95), 1),
            "max": round(max(latencies) if latencies else 0, 1),
        }

        for path in protected_paths:
            code, raw, latency = _request(base, path)
            item = {"path": path, "httpStatus": code, "latencyMs": latency, "raw": raw[:200], "ok": code == 401}
            if code != 401:
                report["failures"].append(f"protected path {path} should reject missing key with 401, actual={code}")
            report["protectedChecks"].append(item)

    report["verdict"] = "fail" if report["failures"] else "pass"
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    print(f"LLM Gateway serving probe: {report['verdict'].upper()}")
    print(f"- samples={len(report['healthSamples'])}")
    print(f"- protected_checks={len(report['protectedChecks'])}")
    print(f"- failures={len(report['failures'])}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
