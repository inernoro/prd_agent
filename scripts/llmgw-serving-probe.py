#!/usr/bin/env python3
"""LLM Gateway serving availability and auth probe.

This read-only probe is meant for S5/S6 rollout evidence. It checks protected
/gw/v1/readyz dependencies with a key, repeatedly checks /gw/v1/healthz without a key,
verifies the reported commit is stable, and checks that protected endpoints
reject unauthenticated access.
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


def _env_first(names: list[str]) -> tuple[str, str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return name, value
    return "", ""


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


def _request(
    base: str,
    path: str,
    key: str | None = None,
    method: str = "GET",
    body: object | None = None,
) -> tuple[int, str, float]:
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method.upper())
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-serving-probe/1.0")
    if data is not None:
        req.add_header("Content-Type", "application/json")
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


def _default_protected_checks() -> list[dict]:
    chat_body = {
        "AppCallerCode": "report-agent.generate::chat",
        "ModelType": "chat",
    }
    raw_body = {
        "AppCallerCode": "report-agent.generate::chat",
        "ModelType": "chat",
        "Protocol": "openai",
        "BaseUrl": "https://example.invalid/v1",
        "Path": "/chat/completions",
        "Method": "POST",
        "Body": {"model": "probe-model", "messages": []},
    }
    profile_body = {
        "AppCallerCode": "infra-agent.runtime-profile-test::chat",
        "Protocol": "openai",
        "BaseUrl": "https://example.invalid/v1",
        "Model": "probe-model",
        "ApiKey": "probe-key",
    }
    return [
        {"method": "GET", "path": "/route-self-test", "body": None},
        {"method": "GET", "path": "/pools?appCallerCode=report-agent.generate%3A%3Achat&modelType=chat", "body": None},
        {"method": "GET", "path": "/shadow-comparisons", "body": None},
        {"method": "POST", "path": "/resolve", "body": chat_body},
        {"method": "POST", "path": "/send", "body": chat_body},
        {"method": "POST", "path": "/stream", "body": chat_body},
        {"method": "POST", "path": "/client-stream", "body": chat_body},
        {"method": "POST", "path": "/raw", "body": raw_body},
        {"method": "POST", "path": "/profile-test", "body": profile_body},
    ]


def _parse_protected_endpoint(raw: str) -> dict:
    value = raw.strip()
    if not value:
        raise ValueError("empty protected endpoint")
    if " " in value:
        method, path = value.split(None, 1)
    elif ":" in value:
        method, path = value.split(":", 1)
    else:
        method, path = "GET", value
    method = method.strip().upper()
    path = path.strip()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise ValueError(f"unsupported method in protected endpoint: {raw}")
    if not path.startswith("/"):
        raise ValueError(f"protected endpoint path must start with '/': {raw}")
    return {"method": method, "path": path, "body": {} if method != "GET" else None}


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
        readiness = report.get("readiness") or {}
        fh.write("## Deep Readiness\n\n")
        fh.write(f"- status: `{cell(readiness.get('status') or '')}`\n")
        fh.write(f"- httpStatus: `{cell(readiness.get('httpStatus'))}`\n")
        fh.write(f"- commit: `{cell(readiness.get('commit') or '')}`\n")
        fh.write(f"- components: `{cell(','.join(readiness.get('components') or []))}`\n\n")
        fh.write("| sample | status | commit | latencyMs |\n")
        fh.write("|---:|---:|---|---:|\n")
        for sample in report["healthSamples"]:
            fh.write(
                f"| {cell(sample['index'])} | {cell(sample['httpStatus'])} | "
                f"{cell(sample.get('commit') or '')} | {cell(round(sample['latencyMs'], 1))} |\n"
            )
        fh.write("\n| method | protectedPath | status | expected |\n")
        fh.write("|---|---|---:|---|\n")
        for item in report["protectedChecks"]:
            fh.write(f"| {cell(item['method'])} | {cell(item['path'])} | {cell(item['httpStatus'])} | 401 |\n")
        route = report.get("routeSelfTest") or {}
        fh.write("\n## Route Self Test\n\n")
        fh.write(f"- required: `{cell(route.get('required'))}`\n")
        fh.write(f"- ok: `{cell(route.get('ok'))}`\n")
        fh.write(f"- keyEnv: `{cell(route.get('keyEnv') or '')}`\n")
        fh.write(f"- protocols: `{cell(','.join(route.get('protocols') or []))}`\n")
        fh.write(f"- missingProtocols: `{cell(','.join(route.get('missingProtocols') or []))}`\n")
        fh.write("\n## Failures\n\n")
        failures = report.get("failures") or []
        if failures:
            for failure in failures:
                fh.write(f"- {failure}\n")
        else:
            fh.write("- none\n")


def _route_self_test_result(raw: str, status_code: int, latency_ms: float, required: bool, key_env: str) -> dict:
    result = {
        "required": required,
        "ok": False,
        "keyEnv": key_env,
        "httpStatus": status_code,
        "latencyMs": latency_ms,
        "selfTestStatus": "",
        "mode": "",
        "upstreamCalled": None,
        "total": None,
        "passed": None,
        "protocols": [],
        "missingProtocols": [],
        "raw": raw[:200],
    }
    if status_code == 0:
        result["missingProtocols"] = ["request_failed"]
        return result
    try:
        payload = _json(raw)
    except Exception:
        result["missingProtocols"] = ["invalid_json"]
        return result

    cases = payload.get("cases") if "cases" in payload else payload.get("Cases")
    if not isinstance(cases, list):
        cases = []
    protocols = sorted({
        str((item.get("ingressProtocol") if isinstance(item, dict) else "") or (item.get("IngressProtocol") if isinstance(item, dict) else "")).strip()
        for item in cases
        if isinstance(item, dict)
    })
    required_protocols = {"gw-native", "openai-compatible", "claude-compatible", "gemini-compatible"}
    missing_protocols = sorted(required_protocols.difference(protocols))
    total = payload.get("total") if "total" in payload else payload.get("Total")
    passed = payload.get("passed") if "passed" in payload else payload.get("Passed")
    self_status = str(payload.get("status") if "status" in payload else payload.get("Status") or "").strip().lower()
    mode = str(payload.get("mode") if "mode" in payload else payload.get("Mode") or "").strip().lower()
    upstream_called = payload.get("upstreamCalled") if "upstreamCalled" in payload else payload.get("UpstreamCalled")

    result.update({
        "selfTestStatus": self_status,
        "mode": mode,
        "upstreamCalled": upstream_called,
        "total": total,
        "passed": passed,
        "protocols": protocols,
        "missingProtocols": missing_protocols,
        "ok": (
            status_code == 200
            and self_status == "ok"
            and mode == "dry-run"
            and upstream_called is False
            and isinstance(total, int)
            and isinstance(passed, int)
            and total == passed
            and total >= len(required_protocols)
            and not missing_protocols
        ),
    })
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway serving availability/auth probe")
    parser.add_argument("--base", default=_default_base(), help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""))
    parser.add_argument("--samples", type=int, default=int(os.environ.get("LLMGW_SERVING_PROBE_SAMPLES", "12")))
    parser.add_argument("--interval", type=float, default=float(os.environ.get("LLMGW_SERVING_PROBE_INTERVAL_SECONDS", "5")))
    parser.add_argument("--protected-path", action="append", default=[],
                        help="backward compatible protected GET path that must reject missing key; repeatable")
    parser.add_argument("--protected-endpoint", action="append", default=[],
                        help="protected endpoint that must reject missing key, format 'METHOD /path' or METHOD:/path; repeatable")
    parser.add_argument("--key", default="", help="Gateway key for authenticated route-self-test; defaults to key envs.")
    parser.add_argument("--key-env", default="LLMGW_GATE_KEY")
    parser.add_argument(
        "--require-route-self-test",
        action="store_true",
        default=os.environ.get("LLMGW_SERVING_PROBE_REQUIRE_ROUTE_SELF_TEST", "").strip().lower() in {"1", "true", "yes", "on"},
        help="Require authenticated /route-self-test to pass and cover all ingress protocols.",
    )
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_SERVING_PROBE_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_SERVING_PROBE_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    base = (args.base or "").strip().rstrip("/")
    key_name, key = _env_first([args.key_env, "LLMGW_GATE_KEY", "LLMGW_SERVE_KEY"])
    key = (args.key or key).strip()
    if args.key:
        key_name = "cli"
    sample_count = max(1, args.samples)
    interval = max(0, args.interval)
    try:
        protected_checks = [{"method": "GET", "path": path, "body": None} for path in args.protected_path]
        protected_checks.extend(_parse_protected_endpoint(item) for item in args.protected_endpoint)
        if not protected_checks:
            protected_checks = _default_protected_checks()
        protected_parse_failure = ""
    except ValueError as exc:
        protected_checks = []
        protected_parse_failure = str(exc)

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail",
        "base": base,
        "expectedCommit": args.expect_commit,
        "sampleCount": sample_count,
        "intervalSeconds": interval,
        "latencyMs": {"p50": 0, "p95": 0, "max": 0},
        "readiness": {
            "httpStatus": None,
            "status": "",
            "commit": "",
            "components": [],
            "latencyMs": 0,
        },
        "healthSamples": [],
        "protectedChecks": [],
        "routeSelfTest": {
            "required": bool(args.require_route_self_test),
            "ok": not bool(args.require_route_self_test),
            "keyEnv": key_name,
            "httpStatus": None,
            "protocols": [],
            "missingProtocols": [],
        },
        "failures": [],
    }

    if not base:
        report["failures"].append("missing --base/GW_BASE")
    if protected_parse_failure:
        report["failures"].append(protected_parse_failure)
    if not report["failures"]:
        ready_code, ready_raw, ready_latency = _request(base, "/readyz", key=key)
        readiness = {
            "httpStatus": ready_code,
            "status": "",
            "commit": "",
            "components": [],
            "latencyMs": ready_latency,
            "raw": ready_raw[:500],
        }
        try:
            ready_payload = _json(ready_raw)
            readiness["status"] = str(ready_payload.get("status") or ready_payload.get("Status") or "")
            readiness["commit"] = str(ready_payload.get("commit") or ready_payload.get("Commit") or "")
            components = ready_payload.get("components") or ready_payload.get("Components") or []
            readiness["components"] = [
                str(item.get("name") or item.get("Name") or "")
                for item in components
                if isinstance(item, dict)
            ]
        except Exception as exc:
            report["failures"].append(f"readyz invalid JSON: {exc}")
        report["readiness"] = readiness
        if ready_code != 200 or readiness["status"].lower() not in {"ready", "ok"}:
            report["failures"].append(
                f"readyz not ready: HTTP {ready_code}, status={readiness['status'] or 'empty'}"
            )
        if args.expect_commit and readiness["commit"] and readiness["commit"] != args.expect_commit:
            report["failures"].append(
                f"readyz commit mismatch: actual={readiness['commit']}, expected={args.expect_commit}"
            )

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

        for check in protected_checks:
            method = str(check["method"]).upper()
            path = str(check["path"])
            code, raw, latency = _request(base, path, method=method, body=check.get("body"))
            item = {
                "method": method,
                "path": path,
                "httpStatus": code,
                "latencyMs": latency,
                "raw": raw[:200],
                "ok": code == 401,
            }
            if code != 401:
                report["failures"].append(f"protected endpoint {method} {path} should reject missing key with 401, actual={code}")
            report["protectedChecks"].append(item)

        if args.require_route_self_test:
            if not key:
                report["failures"].append("route-self-test requires gateway key but none was configured")
            else:
                code, raw, latency = _request(base, "/route-self-test", key=key)
                route_result = _route_self_test_result(raw, code, latency, required=True, key_env=key_name)
                report["routeSelfTest"] = route_result
                if not route_result["ok"]:
                    report["failures"].append(
                        "route-self-test failed: "
                        f"status={route_result.get('httpStatus')} "
                        f"selfTestStatus={route_result.get('selfTestStatus') or 'empty'} "
                        f"mode={route_result.get('mode') or 'empty'} "
                        f"missingProtocols={','.join(route_result.get('missingProtocols') or []) or 'none'}"
                    )

    report["verdict"] = "fail" if report["failures"] else "pass"
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    print(f"LLM Gateway serving probe: {report['verdict'].upper()}")
    print(f"- samples={len(report['healthSamples'])}")
    print(f"- readiness={report['readiness'].get('status')}")
    print(f"- protected_checks={len(report['protectedChecks'])}")
    print(f"- route_self_test={report['routeSelfTest'].get('ok')}")
    print(f"- failures={len(report['failures'])}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
