#!/usr/bin/env python3
"""LLM Gateway 发布前证据门。

这个脚本只读 serving 网关：
  - /gw/v1/healthz 必须 200
  - /gw/v1/shadow-comparisons 必须可读
  - critical mismatch 必须为 0
  - httpFail 必须为 0
  - total 样本数必须达到阈值
  - 可选：指定 kind/appCaller+kind 的真实样本数必须达到阈值，避免只靠 resolve-only 放行

用法：
  GW_BASE=https://<preview>-llmgw-serve.miduo.org/gw/v1 \
  GW_KEY=<X-Gateway-Key> \
  python3 scripts/llmgw-release-gate.py --min-total 30 \
    --app-caller report-agent.generate::chat --min-per-app 30 \
    --require-kind send:30 \
    --require-app-kind report-agent.generate::chat:send:30
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


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


def _json(raw: str) -> dict:
    try:
        value = json.loads(raw)
    except Exception as exc:
        raise ValueError(f"响应不是 JSON: {raw[:200]}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"响应不是 JSON object: {raw[:200]}")
    return value


def _check_shadow(base: str, key: str, app: str | None, min_total: int, kind: str | None = None) -> list[str]:
    label = "global"
    query_items: dict[str, str] = {}
    if app:
        query_items["appCallerCode"] = app
        label = app
    if kind:
        query_items["kind"] = kind
        label = f"{label}/{kind}"
    query = ("?" + urllib.parse.urlencode(query_items)) if query_items else ""

    code, raw = _request("GET", base, "/shadow-comparisons" + query, key)
    if code != 200:
        return [f"shadow[{label}] HTTP {code}: {raw[:200]}"]

    payload = _json(raw)
    summary = payload.get("summary") or payload.get("Summary") or {}
    total = int(summary.get("total") or summary.get("Total") or 0)
    critical = int(summary.get("critical") or summary.get("Critical") or 0)
    http_fail = int(summary.get("httpFail") or summary.get("HttpFail") or 0)

    failures: list[str] = []
    if total < min_total:
        failures.append(f"shadow[{label}] 样本不足: total={total}, required={min_total}")
    if critical != 0:
        failures.append(f"shadow[{label}] critical mismatch 未清零: {critical}")
    if http_fail != 0:
        failures.append(f"shadow[{label}] httpFail 未清零: {http_fail}")
    return failures


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
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""), help="可选：healthz commit 必须匹配")
    args = parser.parse_args()

    base = (args.base or _default_base()).rstrip("/")
    if not base:
        print("FAIL: 缺少 GW_BASE/--base，且 cdscli preview-url 未取到根域名")
        return 2
    if not args.key:
        print("FAIL: 缺少 GW_KEY/--key，无法读取受保护 shadow-comparisons")
        return 2

    failures: list[str] = []

    code, raw = _request("GET", base, "/healthz", None)
    if code != 200:
        failures.append(f"healthz HTTP {code}: {raw[:200]}")
    else:
        try:
            health = _json(raw)
            commit = str(health.get("commit") or health.get("Commit") or "")
            if args.expect_commit and commit and commit != args.expect_commit:
                failures.append(f"healthz commit 不匹配: actual={commit}, expected={args.expect_commit}")
        except ValueError as exc:
            failures.append(str(exc))

    failures.extend(_check_shadow(base, args.key, None, args.min_total))
    for app in args.app_caller:
        failures.extend(_check_shadow(base, args.key, app, args.min_per_app))
    for raw in args.require_kind:
        try:
            kind, min_total = _parse_kind_requirement(raw, args.min_per_app)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        failures.extend(_check_shadow(base, args.key, None, min_total, kind=kind))
    for raw in args.require_app_kind:
        try:
            app, kind, min_total = _parse_app_kind_requirement(raw)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        failures.extend(_check_shadow(base, args.key, app, min_total, kind=kind))

    if failures:
        print("LLM Gateway release gate: FAIL")
        for item in failures:
            print(f"- {item}")
        return 1

    print("LLM Gateway release gate: PASS")
    print(f"- base={base}")
    print(f"- global_min_total={args.min_total}")
    if args.app_caller:
        print(f"- app_callers={len(args.app_caller)} min_per_app={args.min_per_app}")
    if args.require_kind:
        print(f"- required_kinds={len(args.require_kind)}")
    if args.require_app_kind:
        print(f"- required_app_kinds={len(args.require_app_kind)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
