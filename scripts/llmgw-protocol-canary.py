#!/usr/bin/env python3
"""LLM Gateway four-protocol runtime canary.

Default mode is dry-run: healthz + route-self-test only, no upstream model call.
Use --execute to send one tiny request per protocol and generate real runtime
logs for protocol_runtime_coverage. Keep this script explicit and bounded so it
does not repeat costly tests by accident.
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
from typing import Any


TARGET_PROTOCOLS = ("gw-native", "openai-compatible", "claude-compatible", "gemini-compatible")
DEFAULT_APP_CALLER = "report-agent.generate::chat"


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
        return root.rstrip("/")
    except Exception:
        return ""


def _base_root(raw: str) -> str:
    value = raw.strip().rstrip("/")
    if value.endswith("/gw/v1"):
        return value[:-6].rstrip("/")
    return value


def _gateway_v1_base(root: str) -> str:
    return root.rstrip("/") + "/gw/v1"


def _request(
    root: str,
    path: str,
    key: str,
    body: object | None = None,
    method: str = "POST",
    headers: dict[str, str] | None = None,
    timeout: int = 120,
) -> tuple[int, str, float]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(root.rstrip("/") + path, data=data, method=method.upper())
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-protocol-canary/1.0")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-Gateway-Key", key)
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = (time.monotonic() - started) * 1000
            return resp.status, resp.read().decode("utf-8", "replace"), elapsed_ms
    except urllib.error.HTTPError as exc:
        elapsed_ms = (time.monotonic() - started) * 1000
        return exc.code, exc.read().decode("utf-8", "replace"), elapsed_ms
    except Exception as exc:
        elapsed_ms = (time.monotonic() - started) * 1000
        return 0, f"ERR {exc}", elapsed_ms


def _json(raw: str) -> dict[str, Any]:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    return payload


def _normalize_commit(value: object) -> str:
    raw = str(value or "").strip().lower()
    if raw.startswith("sha-"):
        raw = raw[4:]
    return raw


def _body_for_protocol(protocol: str, max_tokens: int, prompt: str) -> tuple[str, dict[str, Any]]:
    if protocol == "gw-native":
        return "/gw/v1/invoke", {
            "AppCallerCode": DEFAULT_APP_CALLER,
            "ModelType": "chat",
            "Stream": False,
            "RequestBody": {
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
            },
            "Context": {
                "UserId": "llmgw-protocol-canary",
            },
        }
    if protocol == "openai-compatible":
        return "/v1/chat/completions", {
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0,
        }
    if protocol == "claude-compatible":
        return "/v1/messages", {
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0,
        }
    if protocol == "gemini-compatible":
        return "/v1beta/models/gateway-auto:generateContent", {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ],
            "generationConfig": {
                "maxOutputTokens": max_tokens,
                "temperature": 0,
            },
        }
    raise ValueError(f"unsupported protocol: {protocol}")


def _headers_for_protocol(protocol: str, run_id: str) -> dict[str, str]:
    headers = {
        "X-Gateway-App-Caller": DEFAULT_APP_CALLER,
        "X-Gateway-Source": "canary",
        "X-Gateway-User-Id": "llmgw-protocol-canary",
        "X-Gateway-Run-Id": run_id,
        "X-Gateway-Model-Policy": "auto",
    }
    if protocol in {"openai-compatible", "claude-compatible", "gemini-compatible"}:
        headers["X-Gateway-App-Title"] = "LLM Gateway protocol canary"
    return headers


def _is_success(protocol: str, status: int, raw: str) -> tuple[bool, str]:
    if status < 200 or status >= 300:
        return False, f"HTTP {status}: {raw[:180]}"
    try:
        payload = _json(raw)
    except Exception:
        return False, f"HTTP {status}: invalid JSON"
    if protocol == "gw-native":
        success = payload.get("Success") if "Success" in payload else payload.get("success")
        content = payload.get("Content") if "Content" in payload else payload.get("content")
        resolution = payload.get("Resolution") if "Resolution" in payload else payload.get("resolution")
        model = ""
        if isinstance(resolution, dict):
            model = str(resolution.get("ActualModel") or resolution.get("actualModel") or "")
        return bool(success is True and str(content or "").strip() and model), (
            f"HTTP {status} success={success} model={model or 'empty'} contentLen={len(str(content or ''))}"
        )
    if protocol == "openai-compatible":
        choices = payload.get("choices") or payload.get("Choices")
        model = payload.get("model") or payload.get("Model")
        ok = isinstance(choices, list) and len(choices) > 0
        return ok, f"HTTP {status} model={model or 'empty'} choices={len(choices) if isinstance(choices, list) else 0}"
    if protocol == "claude-compatible":
        content = payload.get("content") or payload.get("Content")
        model = payload.get("model") or payload.get("Model")
        ok = isinstance(content, list) and len(content) > 0
        return ok, f"HTTP {status} model={model or 'empty'} content={len(content) if isinstance(content, list) else 0}"
    if protocol == "gemini-compatible":
        candidates = payload.get("candidates") or payload.get("Candidates")
        ok = isinstance(candidates, list) and len(candidates) > 0
        return ok, f"HTTP {status} candidates={len(candidates) if isinstance(candidates, list) else 0}"
    return False, f"unknown protocol {protocol}"


def _health_check(root: str, expected_commit: str, timeout: int) -> tuple[dict[str, Any], list[str]]:
    status, raw, latency = _request(root, "/gw/v1/healthz", key="", body=None, method="GET", timeout=timeout)
    item = {"httpStatus": status, "latencyMs": round(latency, 1), "commit": "", "ok": False, "raw": raw[:200]}
    failures: list[str] = []
    if status != 200:
        failures.append(f"healthz HTTP {status}: {raw[:180]}")
        return item, failures
    try:
        payload = _json(raw)
        commit = _normalize_commit(payload.get("commit") or payload.get("Commit"))
        item["commit"] = commit
        item["ok"] = str(payload.get("status") or payload.get("Status") or "").lower() == "ok"
        if expected_commit and commit and commit != expected_commit:
            item["ok"] = False
            failures.append(f"healthz commit mismatch: actual={commit}, expected={expected_commit}")
    except Exception as exc:
        item["ok"] = False
        failures.append(f"healthz invalid JSON: {exc}")
    return item, failures


def _route_self_test(root: str, key: str, timeout: int) -> tuple[dict[str, Any], list[str]]:
    status, raw, latency = _request(root, "/gw/v1/route-self-test", key=key, body=None, method="GET", timeout=timeout)
    result = {
        "httpStatus": status,
        "latencyMs": round(latency, 1),
        "status": "",
        "mode": "",
        "upstreamCalled": None,
        "protocols": [],
        "missingProtocols": list(TARGET_PROTOCOLS),
        "ok": False,
        "raw": raw[:200],
    }
    failures: list[str] = []
    if status != 200:
        failures.append(f"route-self-test HTTP {status}: {raw[:180]}")
        return result, failures
    try:
        payload = _json(raw)
        cases = payload.get("cases") or payload.get("Cases") or []
        protocols = sorted({
            str((case.get("ingressProtocol") if isinstance(case, dict) else "") or (case.get("IngressProtocol") if isinstance(case, dict) else "")).strip()
            for case in cases
            if isinstance(case, dict)
        })
        missing = sorted(set(TARGET_PROTOCOLS).difference(protocols))
        status_text = str(payload.get("status") or payload.get("Status") or "").strip().lower()
        mode = str(payload.get("mode") or payload.get("Mode") or "").strip().lower()
        upstream_called = payload.get("upstreamCalled") if "upstreamCalled" in payload else payload.get("UpstreamCalled")
        ok = status_text == "ok" and mode == "dry-run" and upstream_called is False and not missing
        result.update({
            "status": status_text,
            "mode": mode,
            "upstreamCalled": upstream_called,
            "protocols": protocols,
            "missingProtocols": missing,
            "ok": ok,
        })
        if not ok:
            failures.append(f"route-self-test not ok: status={status_text or 'empty'} mode={mode or 'empty'} missing={','.join(missing) or 'none'}")
    except Exception as exc:
        failures.append(f"route-self-test invalid JSON: {exc}")
    return result, failures


def _run_case(root: str, key: str, protocol: str, run_id: str, max_tokens: int, timeout: int) -> dict[str, Any]:
    path, body = _body_for_protocol(protocol, max_tokens=max_tokens, prompt="Reply with OK.")
    status, raw, latency = _request(
        root,
        path,
        key=key,
        body=body,
        headers=_headers_for_protocol(protocol, run_id),
        timeout=timeout,
    )
    ok, detail = _is_success(protocol, status, raw)
    return {
        "protocol": protocol,
        "path": path,
        "httpStatus": status,
        "latencyMs": round(latency, 1),
        "ok": ok,
        "detail": detail,
        "raw": raw[:300],
    }


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def _write_markdown(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Protocol Canary Report\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- mode: `{cell(report['mode'])}`\n")
        fh.write(f"- root: `{cell(report['root'])}`\n")
        fh.write(f"- expectedCommit: `{cell(report.get('expectedCommit') or '')}`\n")
        fh.write(f"- runId: `{cell(report['runId'])}`\n")
        fh.write(f"- maxTokens: `{cell(report['maxTokens'])}`\n\n")
        fh.write("## Checks\n\n")
        fh.write(f"- healthz: `{cell(report['health']['ok'])}` commit=`{cell(report['health'].get('commit') or '')}`\n")
        route = report["routeSelfTest"]
        fh.write(f"- routeSelfTest: `{cell(route['ok'])}` protocols=`{cell(','.join(route.get('protocols') or []))}`\n\n")
        fh.write("| protocol | status | http | latencyMs | detail |\n")
        fh.write("|---|---|---:|---:|---|\n")
        for item in report["cases"]:
            fh.write(
                f"| {cell(item['protocol'])} | {cell('pass' if item['ok'] else 'fail')} | "
                f"{cell(item['httpStatus'])} | {cell(item['latencyMs'])} | {cell(item['detail'])} |\n"
            )
        fh.write("\n## Failures\n\n")
        failures = report.get("failures") or []
        if failures:
            for failure in failures:
                fh.write(f"- {failure}\n")
        else:
            fh.write("- none\n")


def _self_test() -> int:
    cases = [
        _is_success("gw-native", 200, json.dumps({"Success": True, "Content": "OK", "Resolution": {"ActualModel": "m"}}))[0],
        _is_success("openai-compatible", 200, json.dumps({"choices": [{"message": {"content": "OK"}}], "model": "m"}))[0],
        _is_success("claude-compatible", 200, json.dumps({"content": [{"type": "text", "text": "OK"}], "model": "m"}))[0],
        _is_success("gemini-compatible", 200, json.dumps({"candidates": [{"content": {"parts": [{"text": "OK"}]}}]}))[0],
        not _is_success("openai-compatible", 500, "{}")[0],
    ]
    if not all(cases):
        print("LLM Gateway protocol canary self-test: FAIL", file=sys.stderr)
        return 1
    print("LLM Gateway protocol canary self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway four-protocol canary")
    parser.add_argument("--base", default=_default_base(), help="preview/root URL or /gw/v1 URL")
    parser.add_argument("--key", default=os.environ.get("GW_KEY") or os.environ.get("LLMGW_GATE_KEY") or os.environ.get("LLMGW_SERVE_KEY") or "")
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""))
    parser.add_argument("--execute", action="store_true", help="send one real small request per protocol")
    parser.add_argument("--protocol", action="append", choices=TARGET_PROTOCOLS, help="limit protocols; repeatable")
    parser.add_argument("--max-tokens", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_PROTOCOL_CANARY_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_PROTOCOL_CANARY_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    root = _base_root(args.base or "")
    key = args.key.strip()
    selected_protocols = tuple(args.protocol or TARGET_PROTOCOLS)
    max_tokens = max(1, min(args.max_tokens, 32))
    run_id = args.run_id.strip() or f"llmgw-protocol-canary-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    expected_commit = _normalize_commit(args.expect_commit)
    report: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail",
        "mode": "execute" if args.execute else "dry-run",
        "root": root,
        "gatewayV1Base": _gateway_v1_base(root) if root else "",
        "expectedCommit": expected_commit,
        "runId": run_id,
        "maxTokens": max_tokens,
        "protocols": list(selected_protocols),
        "health": {},
        "routeSelfTest": {},
        "cases": [],
        "failures": [],
    }
    failures: list[str] = []
    if not root:
        failures.append("missing --base/GW_BASE")
    if not key:
        failures.append("missing --key/GW_KEY/LLMGW_GATE_KEY")
    if not failures:
        health, health_failures = _health_check(root, expected_commit, timeout=args.timeout)
        route, route_failures = _route_self_test(root, key, timeout=args.timeout)
        report["health"] = health
        report["routeSelfTest"] = route
        failures.extend(health_failures)
        failures.extend(route_failures)
        if args.execute:
            for protocol in selected_protocols:
                case = _run_case(root, key, protocol, run_id, max_tokens=max_tokens, timeout=args.timeout)
                report["cases"].append(case)
                if not case["ok"]:
                    failures.append(f"{protocol}: {case['detail']}")
        else:
            report["cases"] = [
                {
                    "protocol": protocol,
                    "path": _body_for_protocol(protocol, max_tokens=max_tokens, prompt="Reply with OK.")[0],
                    "httpStatus": None,
                    "latencyMs": 0,
                    "ok": True,
                    "detail": "dry-run only; add --execute to create runtime logs",
                    "raw": "",
                }
                for protocol in selected_protocols
            ]
    report["failures"] = failures
    report["verdict"] = "fail" if failures else "pass"
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"LLM Gateway protocol canary: {report['verdict'].upper()} mode={report['mode']}")
    print(f"- root={root or 'empty'}")
    print(f"- protocols={','.join(selected_protocols)}")
    print(f"- runId={run_id}")
    print(f"- failures={len(failures)}")
    if not args.execute:
        print("- execute=false; no runtime LLM logs were created")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
