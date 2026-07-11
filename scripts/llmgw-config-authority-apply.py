#!/usr/bin/env python3
"""LLM Gateway 配置权威退场操作脚本。

默认只读控制台 `/gw/config-authority/report`，用于确认 MAP 模型池配置是否已经迁移到
`llm_gateway`。只有显式传 `--execute` 时才会调用写接口：
  1. POST /gw/config-authority/bulk-claim
  2. POST /gw/config-authority/bind-active-app-callers
  3. GET  /gw/config-authority/report

脚本不会打印 token 或密码；证据输出只包含操作结果和 readiness 字段。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def _normalize_base(raw: str) -> str:
    base = raw.strip().rstrip("/")
    if not base:
        return ""
    parsed = urllib.parse.urlparse(base)
    path = (parsed.path or "").rstrip("/")
    if path.endswith("/gw") or path == "/gw":
        return base
    return base + "/gw"


def _request(method: str, base: str, path: str, token: str | None, body: dict | None = None) -> tuple[int, str]:
    data = None
    req = urllib.request.Request(base + path, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-config-authority-apply/1.0")
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


def _int_value(value: object, default: int = 0) -> int:
    try:
        return int(value if value is not None else default)
    except (TypeError, ValueError):
        return default


def _login_token(base: str, username: str, password: str) -> tuple[str | None, list[str]]:
    if not username or not password:
        return None, ["缺少控制台 token，且未提供 LLMGW_CONSOLE_USER/LLMGW_CONSOLE_PASSWORD"]
    code, raw = _request("POST", base, "/auth/login", None, {
        "username": username,
        "password": password,
    })
    if code != 200:
        return None, [f"控制台登录失败 HTTP {code}: {raw[:200]}"]
    try:
        data = _extract_envelope_data(_json(raw))
    except ValueError as exc:
        return None, [str(exc)]
    token = _get_nested(data, "token")
    must_change = bool(_get_nested(data, "mustChangePassword") or False)
    if not token:
        return None, ["控制台登录响应缺少 token"]
    if must_change:
        return None, ["控制台账号处于 mustChangePassword 状态，config authority 操作不允许用未改密账号放行"]
    return str(token), []


def _read_report(base: str, token: str) -> dict:
    result: dict = {
        "ok": False,
        "httpStatus": 0,
        "status": "unknown",
        "mapFallbackObjectsRemaining": None,
        "activeAppCallerMapFallbackReady": False,
        "activeMissingGatewayPool": None,
        "activeBoundPoolWithoutUsableMember": None,
        "readinessPercent": None,
        "gapCount": None,
        "failures": [],
    }
    code, raw = _request("GET", base, "/config-authority/report", token)
    result["httpStatus"] = code
    if code != 200:
        result["failures"].append(f"config-authority report HTTP {code}: {raw[:200]}")
        return result
    try:
        data = _extract_envelope_data(_json(raw))
    except ValueError as exc:
        result["failures"].append(str(exc))
        return result

    summary = _get_nested(data, "summary")
    if not isinstance(summary, dict):
        result["failures"].append(f"config-authority report 缺少 summary: {raw[:200]}")
        return result

    gaps = _get_nested(data, "gaps")
    result["status"] = str(_get_nested(summary, "status") or "unknown")
    result["mapFallbackObjectsRemaining"] = _int_value(_get_nested(summary, "mapFallbackObjectsRemaining"), -1)
    result["activeAppCallerMapFallbackReady"] = bool(_get_nested(summary, "activeAppCallerMapFallbackReady") or False)
    result["activeMissingGatewayPool"] = _int_value(_get_nested(summary, "activeMissingGatewayPool"), -1)
    result["activeBoundPoolWithoutUsableMember"] = _int_value(_get_nested(summary, "activeBoundPoolWithoutUsableMember"), -1)
    result["readinessPercent"] = _int_value(_get_nested(summary, "readinessPercent"), 0)
    result["gapCount"] = len(gaps) if isinstance(gaps, list) else None
    result["failures"] = _readiness_failures(result)
    result["ok"] = not result["failures"]
    return result


def _readiness_failures(report: dict) -> list[str]:
    failures: list[str] = []
    status = str(report.get("status") or "unknown")
    map_remaining = _int_value(report.get("mapFallbackObjectsRemaining"), -1)
    active_ready = bool(report.get("activeAppCallerMapFallbackReady") or False)
    active_missing = _int_value(report.get("activeMissingGatewayPool"), -1)
    active_without_usable = _int_value(report.get("activeBoundPoolWithoutUsableMember"), -1)
    if status.lower() != "ready":
        failures.append(f"config authority status 不是 ready: {status}")
    if map_remaining != 0:
        failures.append(f"MAP fallback 对象未清零: mapFallbackObjectsRemaining={map_remaining}")
    if not active_ready:
        failures.append("active appCaller 尚未全部绑定有效 GW 模型池")
    if active_missing != 0:
        failures.append(f"active appCaller 缺 GW 池: activeMissingGatewayPool={active_missing}")
    if active_without_usable != 0:
        failures.append(f"active appCaller 绑定的 GW 池不可用: activeBoundPoolWithoutUsableMember={active_without_usable}")
    return failures


def _run_action(base: str, token: str, name: str, path: str, body: dict | None = None) -> dict:
    result: dict = {
        "name": name,
        "path": path,
        "httpStatus": 0,
        "ok": False,
        "data": {},
        "failures": [],
    }
    code, raw = _request("POST", base, path, token, body)
    result["httpStatus"] = code
    if code < 200 or code >= 300:
        result["failures"].append(f"{name} HTTP {code}: {raw[:200]}")
        return result
    try:
        result["data"] = _extract_envelope_data(_json(raw))
    except ValueError as exc:
        result["failures"].append(str(exc))
        return result
    result["ok"] = True
    return result


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

    before = report.get("before") or {}
    after = report.get("after") or {}
    actions = report.get("actions") or []
    failures = report.get("failures") or []
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Config Authority Report\n\n")
        fh.write(f"- generatedAt: `{cell(report.get('generatedAt'))}`\n")
        fh.write(f"- verdict: `{cell(report.get('verdict'))}`\n")
        fh.write(f"- execute: `{cell(report.get('execute'))}`\n")
        fh.write(f"- base: `{cell(report.get('base'))}`\n\n")
        fh.write("| phase | status | mapFallbackObjectsRemaining | activeAppCallerMapFallbackReady | activeMissingGatewayPool | activeBoundPoolWithoutUsableMember | readinessPercent | gaps |\n")
        fh.write("|---|---|---:|---|---:|---:|---:|---:|\n")
        for label, item in (("before", before), ("after", after)):
            fh.write(
                f"| {label} | {cell(item.get('status'))} | {cell(item.get('mapFallbackObjectsRemaining'))} | "
                f"{cell(item.get('activeAppCallerMapFallbackReady'))} | {cell(item.get('activeMissingGatewayPool'))} | "
                f"{cell(item.get('activeBoundPoolWithoutUsableMember'))} | {cell(item.get('readinessPercent'))} | {cell(item.get('gapCount'))} |\n"
            )
        fh.write("\n")
        fh.write("| action | httpStatus | ok | summary |\n")
        fh.write("|---|---:|---|---|\n")
        if actions:
            for action in actions:
                data = action.get("data") or {}
                summary = ", ".join(f"{key}={value}" for key, value in sorted(data.items()) if isinstance(value, (str, int, float, bool)))
                fh.write(f"| {cell(action.get('name'))} | {cell(action.get('httpStatus'))} | {cell(action.get('ok'))} | {cell(summary)} |\n")
        else:
            fh.write("| none | 0 | False | dry-run read only |\n")
        fh.write("\n")
        if failures:
            fh.write("## Failures\n\n")
            for item in failures:
                fh.write(f"- {item}\n")
        else:
            fh.write("## Failures\n\n- none\n")


def _finalize(report: dict, json_out: str, report_md: str, print_json: bool) -> int:
    report["verdict"] = "fail" if report.get("failures") else "pass"
    _write_json(json_out, report)
    _write_markdown(report_md, report)
    if print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if report.get("failures") else 0


def _self_test() -> int:
    failures: list[str] = []
    if _normalize_base("https://example.com") != "https://example.com/gw":
        failures.append("normalize base should append /gw")
    if _normalize_base("https://example.com/gw") != "https://example.com/gw":
        failures.append("normalize base should keep /gw")
    if _int_value("7", -1) != 7:
        failures.append("int parser should accept numeric strings")

    ready = {
        "status": "ready",
        "mapFallbackObjectsRemaining": 0,
        "activeAppCallerMapFallbackReady": True,
        "activeMissingGatewayPool": 0,
        "activeBoundPoolWithoutUsableMember": 0,
    }
    if _readiness_failures(ready):
        failures.append("ready report should have no readiness failures")

    not_ready = {
        "status": "needs-migration",
        "mapFallbackObjectsRemaining": 2,
        "activeAppCallerMapFallbackReady": False,
        "activeMissingGatewayPool": 1,
        "activeBoundPoolWithoutUsableMember": 1,
    }
    not_ready_failures = "\n".join(_readiness_failures(not_ready))
    for expected in (
        "config authority status 不是 ready",
        "MAP fallback 对象未清零",
        "active appCaller 尚未全部绑定有效 GW 模型池",
        "active appCaller 缺 GW 池",
        "active appCaller 绑定的 GW 池不可用",
    ):
        if expected not in not_ready_failures:
            failures.append(f"not-ready report missing failure: {expected}")

    if failures:
        print("LLM Gateway config authority apply self-test: FAIL")
        for item in failures:
            print(f"- {item}")
        return 1
    print("LLM Gateway config authority apply self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway 配置权威退场操作脚本")
    parser.add_argument("--self-test", action="store_true",
                        help="只运行本地解析与 readiness 判定自测，不访问网络、不写生产")
    parser.add_argument("--base", default=os.environ.get("LLMGW_CONSOLE_BASE", ""),
                        help="GW 控制台 API base，例如 https://host/gw；未以 /gw 结尾时自动追加")
    parser.add_argument("--token", default=os.environ.get("LLMGW_CONSOLE_TOKEN", ""),
                        help="GW 控制台 Bearer token；为空时可用 LLMGW_CONSOLE_USER/PASSWORD 登录")
    parser.add_argument("--user", default=os.environ.get("LLMGW_CONSOLE_USER", ""),
                        help="GW 控制台用户名，仅在未提供 token 时用于登录")
    parser.add_argument("--password", default=os.environ.get("LLMGW_CONSOLE_PASSWORD", ""),
                        help="GW 控制台密码，仅在未提供 token 时用于登录")
    parser.add_argument("--execute", action="store_true",
                        help="执行写操作；未传时只读取 report 并输出计划")
    parser.add_argument("--overwrite", action="store_true",
                        help="bulk-claim 时覆盖已存在 GW-owned 配置；默认不覆盖")
    parser.add_argument("--skip-bulk-claim", action="store_true",
                        help="execute 时跳过 bulk-claim")
    parser.add_argument("--skip-bind-active", action="store_true",
                        help="execute 时跳过 active appCaller 绑池")
    parser.add_argument("--require-ready", action="store_true",
                        help="要求最终 config authority ready，否则返回非零")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_CONFIG_AUTHORITY_JSON_OUT", ""),
                        help="可选：把操作证据写成 JSON 文件，内容不包含密钥")
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_CONFIG_AUTHORITY_REPORT_MD", ""),
                        help="可选：把操作证据写成 Markdown 报告，内容不包含密钥")
    parser.add_argument("--print-json", action="store_true", help="向 stdout 打印完整 JSON 证据")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()

    base = _normalize_base(args.base)
    report: dict = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "base": base,
        "execute": bool(args.execute),
        "overwrite": bool(args.overwrite),
        "plannedActions": [],
        "actions": [],
        "before": {},
        "after": {},
        "failures": [],
        "verdict": "fail",
    }

    if not base:
        report["failures"].append("缺少 LLMGW_CONSOLE_BASE/--base，无法读取 GW 控制台配置权威报告")
        _finalize(report, args.json_out, args.report_md, args.print_json)
        print("LLM Gateway config authority: FAIL")
        print("- 缺少 LLMGW_CONSOLE_BASE/--base")
        return 2

    token = args.token.strip()
    if not token:
        token, login_failures = _login_token(base, args.user.strip(), args.password.strip())
        if login_failures:
            report["failures"].extend(login_failures)
            _finalize(report, args.json_out, args.report_md, args.print_json)
            print("LLM Gateway config authority: FAIL")
            for item in login_failures:
                print(f"- {item}")
            return 2

    if not token:
        report["failures"].append("控制台 token 为空")
        _finalize(report, args.json_out, args.report_md, args.print_json)
        return 2

    before = _read_report(base, token)
    report["before"] = before
    if before.get("httpStatus") != 200:
        report["failures"].extend(before.get("failures") or [])
        _finalize(report, args.json_out, args.report_md, args.print_json)
        print("LLM Gateway config authority: FAIL")
        for item in report["failures"]:
            print(f"- {item}")
        return 1

    planned: list[str] = []
    if not args.skip_bulk_claim:
        planned.append("bulk-claim")
    if not args.skip_bind_active:
        planned.append("bind-active-app-callers")
    report["plannedActions"] = planned

    if args.execute:
        if not args.skip_bulk_claim:
            action = _run_action(base, token, "bulk-claim", "/config-authority/bulk-claim", {"overwrite": bool(args.overwrite)})
            report["actions"].append(action)
            if not action.get("ok"):
                report["failures"].extend(action.get("failures") or [])
        if not report["failures"] and not args.skip_bind_active:
            action = _run_action(base, token, "bind-active-app-callers", "/config-authority/bind-active-app-callers")
            report["actions"].append(action)
            if not action.get("ok"):
                report["failures"].extend(action.get("failures") or [])
    else:
        report["actions"] = []

    after = _read_report(base, token)
    report["after"] = after
    if after.get("httpStatus") != 200:
        report["failures"].extend(after.get("failures") or [])
    elif args.require_ready:
        report["failures"].extend(after.get("failures") or [])

    code = _finalize(report, args.json_out, args.report_md, args.print_json)
    if code != 0:
        print("LLM Gateway config authority: FAIL")
        for item in report["failures"]:
            print(f"- {item}")
        return code

    print("LLM Gateway config authority: PASS")
    print(f"- base={base}")
    print(f"- execute={bool(args.execute)}")
    print(f"- final_status={after.get('status')}")
    print(f"- mapFallbackObjectsRemaining={after.get('mapFallbackObjectsRemaining')}")
    print(f"- activeAppCallerMapFallbackReady={after.get('activeAppCallerMapFallbackReady')}")
    print(f"- activeMissingGatewayPool={after.get('activeMissingGatewayPool')}")
    if planned:
        print(f"- plannedActions={','.join(planned)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
