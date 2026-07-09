#!/usr/bin/env python3
"""LLM Gateway 发布前证据门。

这个脚本只读 serving 网关：
  - /gw/v1/healthz 必须 200
  - /gw/v1/shadow-comparisons 必须可读
  - critical mismatch 必须为 0
  - httpFail 必须为 0
  - total 样本数必须达到阈值
  - 可选：只统计最近 N 小时 shadow 样本，避免旧证据误放行
  - 可选：要求 shadow 样本覆盖至少 N 小时，避免短时间突刺样本误放行灰度/全量
  - 可选：指定 kind/appCaller+kind 的真实样本数必须达到阈值，避免只靠 resolve-only 放行

用法：
  GW_BASE=https://<preview>-llmgw-serve.miduo.org/gw/v1 \
  GW_KEY=<X-Gateway-Key> \
  python3 scripts/llmgw-release-gate.py --min-total 30 \
    --app-caller report-agent.generate::chat --min-per-app 30 \
    --since-hours 24 \
    --require-kind send:30 \
    --require-app-kind report-agent.generate::chat:send:30

Scoped rollout canaries may pass --skip-global-cells and only provide
--require-app-kind cells. This is intentionally opt-in; full http gates keep
global/kind checks by default.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from time import sleep


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


def _request(method: str, base: str, path: str, key: str | None) -> tuple[int, str]:
    req = urllib.request.Request(base + path, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-release-gate/1.0")
    if key:
        req.add_header("X-Gateway-Key", key)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return 0, f"ERR {exc}"


def _normalize_console_base(raw: str) -> str:
    base = raw.strip().rstrip("/")
    if not base:
        return ""
    parsed = urllib.parse.urlparse(base)
    path = (parsed.path or "").rstrip("/")
    if path.endswith("/gw") or path == "/gw":
        return base
    return base + "/gw"


def _console_request(method: str, base: str, path: str, token: str | None, body: dict | None = None) -> tuple[int, str]:
    data = None
    req = urllib.request.Request(base + path, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-release-gate/1.0")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return 0, f"ERR {exc}"


def _json(raw: str) -> dict:
    try:
        value = json.loads(raw)
    except Exception as exc:
        raise ValueError(f"响应不是 JSON: {raw[:200]}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"响应不是 JSON object: {raw[:200]}")
    return value


def _parse_utc(value: object) -> datetime | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _shadow_check(
    base: str,
    key: str,
    app: str | None,
    min_total: int,
    kind: str | None = None,
    since_hours: float = 0,
    min_coverage_hours: float = 0,
    release_commit: str = "",
) -> dict:
    label = "global"
    query_items: dict[str, str] = {}
    if app:
        query_items["appCallerCode"] = app
        label = app
    if kind:
        query_items["kind"] = kind
        label = f"{label}/{kind}"
    if since_hours > 0:
        query_items["sinceHours"] = f"{since_hours:g}"
    normalized_release_commit = _normalize_commit(release_commit)
    if normalized_release_commit:
        query_items["releaseCommit"] = normalized_release_commit
    query = ("?" + urllib.parse.urlencode(query_items)) if query_items else ""

    code, raw = _request("GET", base, "/shadow-comparisons" + query, key)
    result = {
        "label": label,
        "appCallerCode": app,
        "kind": kind,
        "requiredTotal": min_total,
        "httpStatus": code,
        "total": 0,
        "allMatch": 0,
        "critical": 0,
        "httpFail": 0,
        "sinceHours": since_hours,
        "minCoverageHours": min_coverage_hours,
        "releaseCommit": normalized_release_commit,
        "firstComparedAt": None,
        "lastComparedAt": None,
        "coverageHours": 0.0,
        "ok": False,
        "failures": [],
        "query": query_items,
    }
    if code != 200:
        result["failures"].append(f"shadow[{label}] HTTP {code}: {raw[:200]}")
        return result

    payload = _json(raw)
    summary = payload.get("summary") or payload.get("Summary") or {}
    total = int(summary.get("total") or summary.get("Total") or 0)
    all_match = int(summary.get("allMatch") or summary.get("AllMatch") or 0)
    critical = int(summary.get("critical") or summary.get("Critical") or 0)
    http_fail = int(summary.get("httpFail") or summary.get("HttpFail") or 0)
    first_raw = summary.get("firstComparedAt") or summary.get("FirstComparedAt")
    last_raw = summary.get("lastComparedAt") or summary.get("LastComparedAt")
    coverage_raw = summary.get("coverageHours") or summary.get("CoverageHours")
    first = _parse_utc(first_raw)
    last = _parse_utc(last_raw)
    try:
        coverage_hours = float(coverage_raw) if coverage_raw is not None else 0.0
    except (TypeError, ValueError):
        coverage_hours = 0.0
    if coverage_hours <= 0 and first is not None and last is not None:
        coverage_hours = max(0.0, (last - first).total_seconds() / 3600.0)
    result["total"] = total
    result["allMatch"] = all_match
    result["critical"] = critical
    result["httpFail"] = http_fail
    result["firstComparedAt"] = first.isoformat() if first is not None else None
    result["lastComparedAt"] = last.isoformat() if last is not None else None
    result["coverageHours"] = coverage_hours

    failures: list[str] = []
    if total < min_total:
        failures.append(f"shadow[{label}] 样本不足: total={total}, required={min_total}")
    if min_coverage_hours > 0 and coverage_hours < min_coverage_hours:
        failures.append(
            f"shadow[{label}] 观察时长不足: coverageHours={coverage_hours:.2f}, required={min_coverage_hours:g}"
        )
    if critical != 0:
        failures.append(f"shadow[{label}] critical mismatch 未清零: {critical}")
    if http_fail != 0:
        failures.append(f"shadow[{label}] httpFail 未清零: {http_fail}")
    result["failures"] = failures
    result["ok"] = not failures
    return result


def _check_shadow(base: str, key: str, app: str | None, min_total: int, kind: str | None = None) -> list[str]:
    return list(_shadow_check(base, key, app, min_total, kind).get("failures") or [])


def _normalize_commit(value: str | None) -> str:
    raw = (value or "").strip()
    if raw.lower().startswith("sha-"):
        raw = raw[4:]
    return raw.lower()


def _health_check(base: str, expected_commit: str, samples: int, interval_seconds: float) -> dict:
    sample_count = max(1, samples)
    result = {
        "ok": False,
        "httpStatus": 0,
        "commit": "",
        "stable": False,
        "sampleCount": sample_count,
        "intervalSeconds": interval_seconds,
        "samples": [],
        "failures": [],
    }

    commits: list[str] = []
    failures: list[str] = []
    for idx in range(sample_count):
        code, raw = _request("GET", base, "/healthz", None)
        sample = {"index": idx + 1, "httpStatus": code, "commit": "", "raw": raw[:200]}
        if code != 200:
            failures.append(f"healthz sample {idx + 1}/{sample_count} HTTP {code}: {raw[:200]}")
        else:
            try:
                health = _json(raw)
                commit = str(health.get("commit") or health.get("Commit") or "")
                sample["commit"] = commit
                if commit:
                    commits.append(commit)
                if expected_commit and commit and commit != expected_commit:
                    failures.append(f"healthz sample {idx + 1}/{sample_count} commit 不匹配: actual={commit}, expected={expected_commit}")
            except ValueError as exc:
                failures.append(str(exc))
        result["samples"].append(sample)
        if idx < sample_count - 1 and interval_seconds > 0:
            sleep(interval_seconds)

    distinct_commits = sorted(set(commits))
    if len(distinct_commits) > 1:
        failures.append(f"healthz commit 漂移: {', '.join(distinct_commits)}")

    last_sample = result["samples"][-1] if result["samples"] else {}
    result["httpStatus"] = int(last_sample.get("httpStatus") or 0)
    result["commit"] = str(last_sample.get("commit") or "")
    result["stable"] = len(failures) == 0 and len(distinct_commits) <= 1
    result["failures"] = failures
    result["ok"] = not failures
    return result


def _extract_envelope_data(payload: dict) -> dict:
    success = payload.get("success")
    if success is None:
        success = payload.get("Success")
    if success is False:
        error = payload.get("error") or payload.get("Error") or {}
        message = error.get("message") if isinstance(error, dict) else str(error)
        raise ValueError(f"控制台 API 返回失败: {message or payload}")
    data = payload.get("data")
    if data is None:
        data = payload.get("Data")
    if not isinstance(data, dict):
        raise ValueError(f"控制台 API 响应缺少 data object: {str(payload)[:200]}")
    return data


def _get_nested(payload: dict, *names: str) -> object:
    for name in names:
        if name in payload:
            return payload[name]
        alt = name[:1].upper() + name[1:]
        if alt in payload:
            return payload[alt]
    return None


def _login_console_token(base: str, username: str, password: str) -> tuple[str | None, list[str]]:
    if not username or not password:
        return None, ["缺少控制台 token，且未提供 LLMGW_CONSOLE_USER/LLMGW_CONSOLE_PASSWORD"]
    code, raw = _console_request("POST", base, "/auth/login", None, {
        "username": username,
        "password": password,
    })
    if code != 200:
        return None, [f"控制台登录失败 HTTP {code}: {raw[:200]}"]
    try:
        payload = _json(raw)
        data = _extract_envelope_data(payload)
    except ValueError as exc:
        return None, [str(exc)]
    token = _get_nested(data, "token")
    must_change = bool(_get_nested(data, "mustChangePassword") or False)
    if not token:
        return None, ["控制台登录响应缺少 token"]
    if must_change:
        return None, ["控制台账号处于 mustChangePassword 状态，release gate 不允许用未改密账号放行"]
    return str(token), []


def _config_authority_check(
    console_base: str,
    token: str,
) -> dict:
    result = {
        "ok": False,
        "httpStatus": 0,
        "base": console_base,
        "status": "unknown",
        "mapFallbackObjectsRemaining": None,
        "activeAppCallerMapFallbackReady": False,
        "activeMissingGatewayPool": None,
        "readinessPercent": None,
        "failures": [],
    }
    code, raw = _console_request("GET", console_base, "/config-authority/report", token)
    result["httpStatus"] = code
    if code != 200:
        result["failures"].append(f"config-authority report HTTP {code}: {raw[:200]}")
        return result
    try:
        payload = _json(raw)
        data = _extract_envelope_data(payload)
    except ValueError as exc:
        result["failures"].append(str(exc))
        return result
    summary = _get_nested(data, "summary")
    if not isinstance(summary, dict):
        result["failures"].append(f"config-authority report 缺少 summary: {raw[:200]}")
        return result

    status = str(_get_nested(summary, "status") or "unknown")
    map_remaining_raw = _get_nested(summary, "mapFallbackObjectsRemaining")
    active_ready = bool(_get_nested(summary, "activeAppCallerMapFallbackReady") or False)
    active_missing_raw = _get_nested(summary, "activeMissingGatewayPool")
    readiness_raw = _get_nested(summary, "readinessPercent")
    try:
        map_remaining = int(map_remaining_raw or 0)
    except (TypeError, ValueError):
        map_remaining = -1
    try:
        active_missing = int(active_missing_raw or 0)
    except (TypeError, ValueError):
        active_missing = -1
    try:
        readiness = int(readiness_raw or 0)
    except (TypeError, ValueError):
        readiness = None

    result["status"] = status
    result["mapFallbackObjectsRemaining"] = map_remaining
    result["activeAppCallerMapFallbackReady"] = active_ready
    result["activeMissingGatewayPool"] = active_missing
    result["readinessPercent"] = readiness

    failures: list[str] = []
    if status.lower() != "ready":
        failures.append(f"config authority status 不是 ready: {status}")
    if map_remaining != 0:
        failures.append(f"MAP fallback 对象未清零: mapFallbackObjectsRemaining={map_remaining}")
    if not active_ready:
        failures.append("active appCaller 尚未全部绑定有效 GW 模型池")
    if active_missing != 0:
        failures.append(f"active appCaller 缺 GW 池: activeMissingGatewayPool={active_missing}")

    result["failures"] = failures
    result["ok"] = not failures
    return result


def _runtime_gates_check(console_base: str, token: str, expected_commit: str = "") -> dict:
    result = _runtime_gates_result_from_data(console_base, {}, http_status=0, expected_commit=expected_commit)
    code, raw = _console_request("GET", console_base, "/runtime-gates", token)
    if code != 200:
        result["httpStatus"] = code
        result["failures"].append(f"runtime-gates HTTP {code}: {raw[:200]}")
        return result
    try:
        payload = _json(raw)
        data = _extract_envelope_data(payload)
    except ValueError as exc:
        result["httpStatus"] = code
        result["failures"].append(str(exc))
        return result
    return _runtime_gates_result_from_data(console_base, data, http_status=code, expected_commit=expected_commit)


def _runtime_gates_result_from_data(console_base: str, data: dict, http_status: int = 200, expected_commit: str = "") -> dict:
    result = {
        "required": False,
        "ok": False,
        "httpStatus": http_status,
        "base": console_base,
        "status": "unknown",
        "releaseCommit": "",
        "expectedCommit": _normalize_commit(expected_commit),
        "readyForHttpFull": False,
        "passed": 0,
        "blocked": 0,
        "waiting": 0,
        "retained": 0,
        "generatedAt": None,
        "remainingRuntimeGates": [],
        "remainingRuntimeGateDetails": [],
        "failures": [],
    }

    status = str(_get_nested(data, "status") or "unknown")
    release_commit = _normalize_commit(str(_get_nested(data, "releaseCommit") or ""))
    expected = _normalize_commit(expected_commit)
    ready = bool(_get_nested(data, "readyForHttpFull") or False)
    items_raw = _get_nested(data, "items")
    items = items_raw if isinstance(items_raw, list) else []
    remaining: list[str] = []
    remaining_details: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        blocking = bool(_get_nested(item, "blocking") or False)
        item_status = str(_get_nested(item, "status") or "").lower()
        if blocking and item_status != "pass":
            item_id = str(_get_nested(item, "id") or _get_nested(item, "label") or "unknown")
            facts = _get_nested(item, "facts")
            remaining.append(item_id)
            remaining_details.append({
                "id": item_id,
                "status": item_status or "unknown",
                "label": str(_get_nested(item, "label") or ""),
                "facts": facts if isinstance(facts, dict) else {},
            })

    result["status"] = status
    result["releaseCommit"] = release_commit
    result["readyForHttpFull"] = ready
    result["passed"] = int(_get_nested(data, "passed") or 0)
    result["blocked"] = int(_get_nested(data, "blocked") or 0)
    result["waiting"] = int(_get_nested(data, "waiting") or 0)
    result["retained"] = int(_get_nested(data, "retained") or 0)
    result["generatedAt"] = _get_nested(data, "generatedAt")
    result["remainingRuntimeGates"] = remaining
    result["remainingRuntimeGateDetails"] = remaining_details

    failures: list[str] = []
    if expected and release_commit != expected:
        failures.append(f"runtime gates releaseCommit mismatch: actual={release_commit or 'empty'} expected={expected}")
    if not ready:
        failures.append(f"runtime gates 未 readyForHttpFull: status={status}; remaining={', '.join(remaining) or 'unknown'}")
    if remaining:
        failures.append(f"runtime gates 仍有 blocking gate 未通过: {', '.join(remaining)}")
    result["failures"] = failures
    result["ok"] = not failures
    return result


def _self_test() -> int:
    ready = _runtime_gates_result_from_data("http://console/gw", {
        "status": "ready",
        "releaseCommit": "abc123",
        "readyForHttpFull": True,
        "passed": 8,
        "blocked": 0,
        "waiting": 0,
        "retained": 1,
        "generatedAt": "2026-07-10T00:00:00Z",
        "items": [
            {"id": "shadow_runtime_evidence", "status": "pass", "blocking": True},
            {"id": "legacy_cleanup_after_stability", "status": "retained", "blocking": False},
        ],
    }, expected_commit="abc123")
    blocked = _runtime_gates_result_from_data("http://console/gw", {
        "status": "blocked",
        "releaseCommit": "abc123",
        "readyForHttpFull": False,
        "passed": 6,
        "blocked": 1,
        "waiting": 1,
        "retained": 1,
        "items": [
            {"id": "appcaller_runtime_coverage", "status": "waiting", "blocking": True, "facts": {"missingAppCallers": "2"}},
            {"id": "current_commit_http_transport", "status": "blocked", "blocking": True, "facts": {"nonHttpTransportLogs": "1"}},
            {"id": "dropped_parameter_runtime_evidence", "status": "blocked", "blocking": True, "facts": {"droppedParameterLogs": "1"}},
            {"id": "legacy_cleanup_after_stability", "status": "retained", "blocking": False},
        ],
    }, expected_commit="abc123")
    mismatch = _runtime_gates_result_from_data("http://console/gw", {
        "status": "ready",
        "releaseCommit": "def456",
        "readyForHttpFull": True,
        "items": [
            {"id": "shadow_runtime_evidence", "status": "pass", "blocking": True},
        ],
    }, expected_commit="abc123")
    failures: list[str] = []
    if not ready["ok"] or ready["remainingRuntimeGates"]:
        failures.append(f"ready runtime gates should pass: {ready}")
    if blocked["ok"]:
        failures.append(f"blocked runtime gates should fail: {blocked}")
    if set(blocked["remainingRuntimeGates"]) != {"appcaller_runtime_coverage", "current_commit_http_transport", "dropped_parameter_runtime_evidence"}:
        failures.append(f"blocked runtime gates missing remaining ids: {blocked}")
    if mismatch["ok"] or not any("releaseCommit mismatch" in item for item in mismatch["failures"]):
        failures.append(f"runtime gates commit mismatch should fail: {mismatch}")
    details = blocked.get("remainingRuntimeGateDetails") or []
    detail_facts = {item.get("id"): item.get("facts") for item in details if isinstance(item, dict)}
    if (detail_facts.get("appcaller_runtime_coverage") or {}).get("missingAppCallers") != "2":
        failures.append(f"blocked runtime gates missing structured facts: {blocked}")
    if (detail_facts.get("current_commit_http_transport") or {}).get("nonHttpTransportLogs") != "1":
        failures.append(f"blocked runtime gates missing transport facts: {blocked}")
    with tempfile.TemporaryDirectory(prefix="llmgw-release-gate-self-test-") as tmp:
        md_path = os.path.join(tmp, "release-gate.md")
        _write_markdown(md_path, {
            "generatedAt": "2026-07-10T00:00:00Z",
            "verdict": "fail",
            "base": "http://console/gw",
            "expectedCommit": "abc123",
            "health": {"httpStatus": 200, "commit": "abc123", "stable": True, "sampleCount": 1},
            "configAuthority": {},
            "runtimeGates": blocked,
            "shadowChecks": [],
            "thresholds": {},
            "failures": blocked.get("failures") or [],
        })
        md = open(md_path, "r", encoding="utf-8").read()
        if "current_commit_http_transport" not in md or "nonHttpTransportLogs=1" not in md:
            failures.append(f"runtime gate markdown should include transport facts: {md}")
    if failures:
        print("LLM Gateway release gate self-test: FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("LLM Gateway release gate self-test: PASS")
    return 0


def _parse_kind_requirement(raw: str, default_min: int) -> tuple[str, int]:
    value = raw.strip()
    if not value:
        raise ValueError("空 kind requirement")
    if ":" not in value:
        return value, default_min
    kind, min_raw = value.rsplit(":", 1)
    if not kind.strip() or not min_raw.strip().isdigit():
        raise ValueError(f"kind requirement 格式应为 kind 或 kind:min: {raw}")
    return kind.strip(), int(min_raw.strip())


def _parse_app_kind_requirement(raw: str) -> tuple[str, str, int]:
    parts = raw.strip().rsplit(":", 2)
    if len(parts) != 3 or not parts[0].strip() or not parts[1].strip() or not parts[2].strip().isdigit():
        raise ValueError(f"app kind requirement 格式应为 appCallerCode:kind:min: {raw}")
    return parts[0].strip(), parts[1].strip(), int(parts[2].strip())


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

    health = report.get("health") or {}
    checks = report.get("shadowChecks") or []
    config_authority = report.get("configAuthority") or {}
    runtime_gates = report.get("runtimeGates") or {}
    failures = report.get("failures") or []
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Release Gate Report\n\n")
        fh.write(f"- generatedAt: `{cell(report.get('generatedAt'))}`\n")
        fh.write(f"- verdict: `{cell(report.get('verdict'))}`\n")
        fh.write(f"- base: `{cell(report.get('base'))}`\n")
        fh.write(f"- healthStatus: `{cell(health.get('httpStatus'))}`\n")
        fh.write(f"- healthCommit: `{cell(health.get('commit') or '')}`\n")
        fh.write(f"- healthStable: `{cell(health.get('stable'))}`\n")
        fh.write(f"- healthSamples: `{cell(health.get('sampleCount'))}`\n")
        fh.write(f"- expectedCommit: `{cell(report.get('expectedCommit') or '')}`\n\n")
        if config_authority:
            fh.write("## Config Authority\n\n")
            fh.write(f"- required: `{cell(config_authority.get('required'))}`\n")
            fh.write(f"- status: `{cell(config_authority.get('status'))}`\n")
            fh.write(f"- mapFallbackObjectsRemaining: `{cell(config_authority.get('mapFallbackObjectsRemaining'))}`\n")
            fh.write(f"- activeAppCallerMapFallbackReady: `{cell(config_authority.get('activeAppCallerMapFallbackReady'))}`\n")
            fh.write(f"- activeMissingGatewayPool: `{cell(config_authority.get('activeMissingGatewayPool'))}`\n")
            fh.write(f"- readinessPercent: `{cell(config_authority.get('readinessPercent'))}`\n\n")
        if runtime_gates:
            fh.write("## Runtime Gates\n\n")
            fh.write(f"- required: `{cell(runtime_gates.get('required'))}`\n")
            fh.write(f"- ok: `{cell(runtime_gates.get('ok'))}`\n")
            fh.write(f"- status: `{cell(runtime_gates.get('status'))}`\n")
            fh.write(f"- releaseCommit: `{cell(runtime_gates.get('releaseCommit') or '')}`\n")
            fh.write(f"- expectedCommit: `{cell(runtime_gates.get('expectedCommit') or '')}`\n")
            fh.write(f"- readyForHttpFull: `{cell(runtime_gates.get('readyForHttpFull'))}`\n")
            fh.write(f"- passed: `{cell(runtime_gates.get('passed'))}`\n")
            fh.write(f"- blocked: `{cell(runtime_gates.get('blocked'))}`\n")
            fh.write(f"- waiting: `{cell(runtime_gates.get('waiting'))}`\n")
            remaining = runtime_gates.get("remainingRuntimeGates") or []
            fh.write(f"- remainingRuntimeGates: `{cell(', '.join(remaining) if remaining else 'none')}`\n\n")
            details = runtime_gates.get("remainingRuntimeGateDetails") or []
            if details:
                fh.write("| gate | status | facts |\n")
                fh.write("|---|---|---|\n")
                for item in details:
                    facts = item.get("facts") if isinstance(item, dict) else {}
                    facts_text = ", ".join(f"{k}={v}" for k, v in sorted((facts or {}).items())) if isinstance(facts, dict) else ""
                    fh.write(f"| {cell(item.get('id') if isinstance(item, dict) else '')} | {cell(item.get('status') if isinstance(item, dict) else '')} | {cell(facts_text)} |\n")
                fh.write("\n")
        fh.write(f"- shadowReleaseCommit: `{cell(report.get('shadowReleaseCommit') or '')}`\n")
        fh.write(f"- shadowSinceHours: `{cell((report.get('thresholds') or {}).get('shadowSinceHours'))}`\n")
        fh.write(f"- minCoverageHours: `{cell((report.get('thresholds') or {}).get('minCoverageHours'))}`\n\n")
        fh.write("| label | sinceHours | minCoverageHours | coverageHours | required | total | allMatch | critical | httpFail | status |\n")
        fh.write("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n")
        for item in checks:
            status = "pass" if item.get("ok") else "fail"
            fh.write(
                f"| {cell(item.get('label'))} | {cell(item.get('sinceHours'))} | "
                f"{cell(item.get('minCoverageHours'))} | {cell(round(float(item.get('coverageHours') or 0), 2))} | "
                f"{cell(item.get('requiredTotal'))} | {cell(item.get('total'))} | {cell(item.get('allMatch'))} | "
                f"{cell(item.get('critical'))} | {cell(item.get('httpFail'))} | {status} |\n"
            )
        fh.write("\n")
        if failures:
            fh.write("## Failures\n\n")
            for item in failures:
                fh.write(f"- {item}\n")
        else:
            fh.write("## Failures\n\n- none\n")


def _finalize(report: dict, failures: list[str], json_out: str, report_md: str, print_json: bool) -> int:
    report["failures"] = failures
    report["verdict"] = "fail" if failures else "pass"
    _write_json(json_out, report)
    _write_markdown(report_md, report)
    if print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway 发布前证据门")
    parser.add_argument("--base", default="", help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--key", default=os.environ.get("GW_KEY", ""), help="X-Gateway-Key")
    parser.add_argument("--min-total", type=int, default=30, help="全局 shadow 最小样本数")
    parser.add_argument("--min-per-app", type=int, default=30, help="每个 --app-caller 的最小样本数")
    parser.add_argument("--app-caller", action="append", default=[], help="需要逐个 gate 的 appCallerCode，可重复")
    parser.add_argument("--require-kind", action="append", default=[],
                        help="要求某类 shadow Kind 达到最小样本数，格式 kind 或 kind:min，可重复")
    parser.add_argument("--require-app-kind", action="append", default=[],
                        help="要求某个 appCallerCode 的某类 Kind 达到最小样本数，格式 appCallerCode:kind:min，可重复")
    parser.add_argument("--skip-global-cells", action="store_true",
                        help="跳过默认 global shadow 检查；用于视频暂缓等 scoped canary，默认全量发布不得启用")
    parser.add_argument("--since-hours", type=float, default=float(os.environ.get("LLMGW_GATE_SHADOW_SINCE_HOURS", "0")),
                        help="只统计最近 N 小时 shadow 样本；0 表示不限制。生产 http/canary 发布建议 >=24")
    parser.add_argument("--min-coverage-hours", type=float, default=float(os.environ.get("LLMGW_GATE_MIN_COVERAGE_HOURS", "0")),
                        help="要求每个 shadow 检查覆盖至少 N 小时；0 表示不限制。S5/S6 发布建议 >=24")
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""), help="可选：healthz commit 必须匹配")
    parser.add_argument("--shadow-release-commit", default=os.environ.get("LLMGW_GATE_SHADOW_RELEASE_COMMIT", ""),
                        help="可选：只统计指定 MAP/API commit 产生的 shadow 样本；默认复用 --expect-commit")
    parser.add_argument("--health-samples", type=int, default=int(os.environ.get("LLMGW_GATE_HEALTH_SAMPLES", "1")),
                        help="healthz 连续采样次数，默认 1；正式全量 http 建议 >=3")
    parser.add_argument("--health-interval", type=float, default=float(os.environ.get("LLMGW_GATE_HEALTH_INTERVAL_SECONDS", "0")),
                        help="healthz 多次采样间隔秒数，默认 0")
    parser.add_argument("--require-config-authority", action="store_true",
                        help="要求 GW 控制台配置权威报告 ready：MAP fallback 对象清零且 active appCaller 均绑定 GW 池")
    parser.add_argument("--require-runtime-gates", action="store_true",
                        help="要求 GW 控制台 /runtime-gates readyForHttpFull=true；用于 http-full 部署后最终放行")
    parser.add_argument("--config-authority-base", default=os.environ.get("LLMGW_CONSOLE_BASE", ""),
                        help="GW 控制台 API base，例如 https://host/gw；未以 /gw 结尾时自动追加")
    parser.add_argument("--config-authority-token", default=os.environ.get("LLMGW_CONSOLE_TOKEN", ""),
                        help="GW 控制台 Bearer token；为空时可用 LLMGW_CONSOLE_USER/PASSWORD 登录")
    parser.add_argument("--config-authority-user", default=os.environ.get("LLMGW_CONSOLE_USER", ""),
                        help="GW 控制台用户名，仅在未提供 token 时用于登录")
    parser.add_argument("--config-authority-password", default=os.environ.get("LLMGW_CONSOLE_PASSWORD", ""),
                        help="GW 控制台密码，仅在未提供 token 时用于登录")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_GATE_JSON_OUT", ""),
                        help="可选：把 gate 证据写成 JSON 文件，内容不包含密钥")
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_GATE_REPORT_MD", ""),
                        help="可选：把 gate 证据写成 Markdown 报告，内容不包含密钥")
    parser.add_argument("--print-json", action="store_true", help="可选：向 stdout 打印完整 JSON 证据")
    parser.add_argument("--self-test", action="store_true", help="离线验证 runtime-gates pass/fail 解析逻辑，不访问网络")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()

    base = (args.base or _default_base()).rstrip("/")
    shadow_release_commit = _normalize_commit(args.shadow_release_commit or args.expect_commit)

    report: dict = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "base": base,
        "expectedCommit": args.expect_commit,
        "shadowReleaseCommit": shadow_release_commit,
        "thresholds": {
            "minTotal": args.min_total,
            "minPerApp": args.min_per_app,
            "shadowSinceHours": max(0, args.since_hours),
            "minCoverageHours": max(0, args.min_coverage_hours),
            "healthSamples": max(1, args.health_samples),
            "healthIntervalSeconds": args.health_interval,
            "skipGlobalCells": bool(args.skip_global_cells),
        },
        "health": {
            "httpStatus": 0,
            "commit": "",
            "stable": False,
            "sampleCount": max(1, args.health_samples),
            "intervalSeconds": args.health_interval,
            "samples": [],
            "failures": [],
        },
        "configAuthority": {
            "required": bool(args.require_config_authority),
            "ok": None,
            "httpStatus": None,
            "base": _normalize_console_base(args.config_authority_base),
            "status": "not-required",
            "mapFallbackObjectsRemaining": None,
            "activeAppCallerMapFallbackReady": None,
            "activeMissingGatewayPool": None,
            "readinessPercent": None,
            "failures": [],
        },
        "runtimeGates": {
            "required": bool(args.require_runtime_gates),
            "ok": None,
            "httpStatus": None,
            "base": _normalize_console_base(args.config_authority_base),
            "status": "not-required",
            "releaseCommit": "",
            "expectedCommit": _normalize_commit(args.expect_commit),
            "readyForHttpFull": None,
            "passed": None,
            "blocked": None,
            "waiting": None,
            "retained": None,
            "generatedAt": None,
            "remainingRuntimeGates": [],
            "remainingRuntimeGateDetails": [],
            "failures": [],
        },
        "shadowChecks": [],
        "failures": [],
        "verdict": "fail",
    }

    if not base:
        print("FAIL: 缺少 GW_BASE/--base，且 cdscli preview-url 未取到根域名")
        _finalize(
            report,
            ["缺少 GW_BASE/--base，且 cdscli preview-url 未取到根域名"],
            args.json_out,
            args.report_md,
            args.print_json,
        )
        return 2
    if not args.key:
        print("FAIL: 缺少 GW_KEY/--key，无法读取受保护 shadow-comparisons")
        _finalize(
            report,
            ["缺少 GW_KEY/--key，无法读取受保护 shadow-comparisons"],
            args.json_out,
            args.report_md,
            args.print_json,
        )
        return 2

    failures: list[str] = []

    health = _health_check(base, args.expect_commit, args.health_samples, args.health_interval)
    report["health"] = health
    failures.extend(health.get("failures") or [])

    if args.require_config_authority or args.require_runtime_gates:
        console_base = _normalize_console_base(args.config_authority_base)
        if not console_base:
            message = "缺少 LLMGW_CONSOLE_BASE/--config-authority-base，无法检查 GW 控制台发布门"
            failures.append(message)
            if args.require_config_authority:
                report["configAuthority"]["failures"] = [message]
            if args.require_runtime_gates:
                report["runtimeGates"]["failures"] = [message]
        else:
            token = args.config_authority_token.strip()
            if not token:
                token, login_failures = _login_console_token(
                    console_base,
                    args.config_authority_user.strip(),
                    args.config_authority_password.strip(),
                )
                if login_failures:
                    failures.extend(login_failures)
                    if args.require_config_authority:
                        report["configAuthority"]["failures"] = login_failures
                    if args.require_runtime_gates:
                        report["runtimeGates"]["failures"] = login_failures
            if token and args.require_config_authority:
                config_check = _config_authority_check(console_base, token)
                config_check["required"] = True
                report["configAuthority"] = config_check
                failures.extend(config_check.get("failures") or [])
            if token and args.require_runtime_gates:
                runtime_check = _runtime_gates_check(console_base, token, expected_commit=args.expect_commit)
                runtime_check["required"] = True
                report["runtimeGates"] = runtime_check
                failures.extend(runtime_check.get("failures") or [])

    shadow_checks: list[dict] = []
    since_hours = max(0, args.since_hours)
    min_coverage_hours = max(0, args.min_coverage_hours)
    if not args.skip_global_cells:
        shadow_checks.append(_shadow_check(
            base,
            args.key,
            None,
            args.min_total,
            since_hours=since_hours,
            min_coverage_hours=min_coverage_hours,
            release_commit=shadow_release_commit,
        ))
    for app in args.app_caller:
        shadow_checks.append(_shadow_check(
            base,
            args.key,
            app,
            args.min_per_app,
            since_hours=since_hours,
            min_coverage_hours=min_coverage_hours,
            release_commit=shadow_release_commit,
        ))
    for raw in args.require_kind:
        try:
            kind, min_total = _parse_kind_requirement(raw, args.min_per_app)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        shadow_checks.append(_shadow_check(
            base,
            args.key,
            None,
            min_total,
            kind=kind,
            since_hours=since_hours,
            min_coverage_hours=min_coverage_hours,
            release_commit=shadow_release_commit,
        ))
    for raw in args.require_app_kind:
        try:
            app, kind, min_total = _parse_app_kind_requirement(raw)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        shadow_checks.append(_shadow_check(
            base,
            args.key,
            app,
            min_total,
            kind=kind,
            since_hours=since_hours,
            min_coverage_hours=min_coverage_hours,
            release_commit=shadow_release_commit,
        ))

    report["shadowChecks"] = shadow_checks
    for item in shadow_checks:
        failures.extend(item.get("failures") or [])

    if failures:
        _finalize(report, failures, args.json_out, args.report_md, args.print_json)
        print("LLM Gateway release gate: FAIL")
        for item in failures:
            print(f"- {item}")
        return 1

    _finalize(report, failures, args.json_out, args.report_md, args.print_json)
    print("LLM Gateway release gate: PASS")
    print(f"- base={base}")
    print(f"- global_min_total={args.min_total}")
    if since_hours > 0:
        print(f"- shadow_since_hours={since_hours:g}")
    if min_coverage_hours > 0:
        print(f"- min_coverage_hours={min_coverage_hours:g}")
    if args.app_caller:
        print(f"- app_callers={len(args.app_caller)} min_per_app={args.min_per_app}")
    if args.require_kind:
        print(f"- required_kinds={len(args.require_kind)}")
    if args.require_app_kind:
        print(f"- required_app_kinds={len(args.require_app_kind)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
