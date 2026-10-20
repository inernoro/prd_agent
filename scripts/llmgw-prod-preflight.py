#!/usr/bin/env python3
"""LLM Gateway production preflight.

This script is an operator check for production releases. It does not deploy or
mutate business data. RSA authentication may create a short-lived session and
reconcile the dedicated stable-smoke identity. The check verifies that the
operator has enough production access to inspect MAP logs and probe llmgw-serve,
that MAP and the gateway run the expected commit, and that MAP logged no direct
(non-gateway) model calls.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

def _env_first(names: list[str]) -> tuple[str, str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return name, value
    return "", ""


def _join_unique(names: list[str]) -> str:
    seen: list[str] = []
    for name in names:
        if name and name not in seen:
            seen.append(name)
    return "/".join(seen)


def _http_json(url: str, headers: dict[str, str] | None = None, method: str = "GET", body: bytes | None = None, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(2_000_000)
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(2_000_000)
        status = exc.code
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": 0, "error": f"{type(exc).__name__}: {str(exc)[:180]}"}

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        payload = {"raw": raw.decode("utf-8", "replace")[:500]}
    return {"ok": 200 <= status < 300, "status": status, "payload": payload}


def _redact_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if not parsed.query:
        return url
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "?redacted", parsed.fragment))


def _payload_dict(value: object, name: str) -> dict:
    if isinstance(value, dict):
        child = value.get(name) or value.get(name[:1].upper() + name[1:])
        return child if isinstance(child, dict) else {}
    return {}


def _item_value(item: dict, *names: str) -> str:
    for name in names:
        value = item.get(name)
        if value is None:
            value = item.get(name[:1].upper() + name[1:])
        if value is not None:
            return str(value)
    return ""


def _stable_smoke_session(base: str, timeout: int) -> tuple[str, str, dict] | None:
    """Use the long-lived RSA identity to mint a short-lived MAP session."""
    key_id = os.environ.get("STABLE_SMOKE_SIGNING_KEY_ID", "").strip()
    private_key = os.environ.get("STABLE_SMOKE_SIGNING_PRIVATE_KEY", "").strip()
    username = os.environ.get("STABLE_SMOKE_USER", "").strip()
    if not any((key_id, private_key, username)):
        return None
    if not all((key_id, private_key, username)):
        return "STABLE_SMOKE_RSA", "", {
            "name": "map_signed_session",
            "ok": False,
            "detail": "STABLE_SMOKE_SIGNING_KEY_ID、STABLE_SMOKE_SIGNING_PRIVATE_KEY、STABLE_SMOKE_USER 必须同时配置",
        }

    ticket_path = "/api/v1/auth/synthetic/ticket"
    ticket_body = json.dumps({"returnUrl": "/", "expiresInSeconds": 180}, separators=(",", ":"))
    signature_script = Path(__file__).with_name("stable-smoke-signature.mjs")
    signature_env = dict(os.environ)
    signature_env["STABLE_SMOKE_SIGNING_KEY_ID"] = key_id
    signature_env["STABLE_SMOKE_SIGNING_PRIVATE_KEY"] = private_key
    try:
        signed = subprocess.run(
            [
                "node", str(signature_script),
                "--method", "POST",
                "--url", f"{base}{ticket_path}",
                "--body", ticket_body,
                "--username", username,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=signature_env,
        )
        signature_headers = json.loads(signed.stdout)
    except Exception as exc:  # noqa: BLE001
        return "STABLE_SMOKE_RSA", "", {
            "name": "map_signed_session",
            "ok": False,
            "detail": f"签名生成失败：{type(exc).__name__}",
        }

    ticket = _http_json(
        f"{base}{ticket_path}",
        headers={"Content-Type": "application/json", **signature_headers},
        method="POST",
        body=ticket_body.encode("utf-8"),
        timeout=timeout,
    )
    ticket_payload = ticket.get("payload") if isinstance(ticket.get("payload"), dict) else {}
    ticket_data = _payload_dict(ticket_payload, "data")
    login_url = str(ticket_data.get("loginUrl") or ticket_data.get("LoginUrl") or "")
    code = urllib.parse.parse_qs(urllib.parse.urlsplit(login_url).fragment).get("code", [""])[0]
    if not ticket.get("ok") or not code:
        error = _payload_dict(ticket_payload, "error")
        return "STABLE_SMOKE_RSA", "", {
            "name": "map_signed_session",
            "ok": False,
            "detail": json.dumps({
                "stage": "ticket",
                "status": ticket.get("status"),
                "errorCode": error.get("code") or error.get("Code"),
            }, ensure_ascii=False),
        }

    exchange_body = json.dumps({"code": code}, separators=(",", ":")).encode("utf-8")
    exchange = _http_json(
        f"{base}/api/v1/auth/synthetic/exchange",
        headers={"Content-Type": "application/json"},
        method="POST",
        body=exchange_body,
        timeout=timeout,
    )
    exchange_payload = exchange.get("payload") if isinstance(exchange.get("payload"), dict) else {}
    exchange_data = _payload_dict(exchange_payload, "data")
    token = str(exchange_data.get("accessToken") or exchange_data.get("AccessToken") or "").strip()
    error = _payload_dict(exchange_payload, "error")
    return "STABLE_SMOKE_RSA", token, {
        "name": "map_signed_session",
        "ok": exchange.get("ok") is True and bool(token),
        "detail": json.dumps({
            "stage": "exchange",
            "status": exchange.get("status"),
            "keyId": key_id,
            "username": username,
            "errorCode": error.get("code") or error.get("Code"),
        }, ensure_ascii=False),
    }


def _direct_transport_check(args: argparse.Namespace, base: str, key_name: str, key: str) -> dict:
    since_hours = max(0.0, float(args.direct_transport_since_hours))
    page_size = min(max(10, int(args.direct_transport_page_size)), 200)
    max_pages = max(1, int(args.direct_transport_max_pages))
    from_dt = datetime.now(timezone.utc) - timedelta(hours=since_hours) if since_hours > 0 else None
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}

    total: int | None = None
    scanned = 0
    direct_samples: list[dict[str, str]] = []
    failures: list[str] = []

    for page in range(1, max_pages + 1):
        query: dict[str, object] = {"page": page, "pageSize": page_size}
        if from_dt:
            query["from"] = from_dt.isoformat()
        logs_url = f"{base}/api/logs/llm?" + urllib.parse.urlencode(query)
        logs = _http_json(logs_url, headers=headers, timeout=args.timeout)
        if not logs["ok"]:
            failures.append(f"page={page} status={logs['status']}")
            break

        payload = logs.get("payload") if isinstance(logs.get("payload"), dict) else {}
        data = _payload_dict(payload, "data")
        items = data.get("items") or data.get("Items") or []
        if not isinstance(items, list):
            failures.append(f"page={page} items_not_list")
            break

        total_value = data.get("total") if "total" in data else data.get("Total")
        if isinstance(total_value, int):
            total = total_value
        elif isinstance(total_value, str) and total_value.isdigit():
            total = int(total_value)
        elif total is None:
            total = len(items)

        scanned += len(items)
        for item in items:
            if not isinstance(item, dict):
                continue
            transport = _item_value(item, "gatewayTransport", "transport").strip().lower()
            if transport == "direct":
                direct_samples.append({
                    "requestId": _item_value(item, "requestId"),
                    "appCallerCode": _item_value(item, "appCallerCode"),
                    "provider": _item_value(item, "provider"),
                    "model": _item_value(item, "model"),
                    "startedAt": _item_value(item, "startedAt", "createdAt"),
                    "gatewayTransport": transport,
                })
                if len(direct_samples) >= 10:
                    break
        if direct_samples:
            break
        if len(items) == 0 or (total is not None and scanned >= total):
            break

    truncated = total is not None and scanned < total and not direct_samples and not failures
    ok = not failures and not direct_samples and not truncated
    return {
        "name": "map_direct_transport_absent",
        "ok": ok,
        "detail": json.dumps({
            "keyEnv": key_name,
            "directTransportSinceHours": since_hours,
            "from": from_dt.isoformat() if from_dt else None,
            "pageSize": page_size,
            "maxPages": max_pages,
            "scanned": scanned,
            "total": total,
            "truncated": truncated,
            "directCountInScanned": len(direct_samples),
            "directSamples": direct_samples,
            "failures": failures,
        }, ensure_ascii=False),
    }


def _map_checks(args: argparse.Namespace) -> list[dict]:
    checks: list[dict] = []
    base = (args.map_base or os.environ.get("PRD_AGENT_BASE", "")).strip().rstrip("/")
    key_name, key = _env_first([args.map_key_env, "PRD_AGENT_API_KEY"])
    if not base:
        checks.append({
            "name": "map_base_configured",
            "ok": False,
            "detail": "missing PRD_AGENT_BASE or --map-base",
        })
        return checks
    checks.append({"name": "map_base_configured", "ok": True, "detail": base})

    signed_session = _stable_smoke_session(base, args.timeout)
    if signed_session is not None:
        key_name, key, signed_session_check = signed_session
        checks.append(signed_session_check)

    health = _http_json(f"{base}/health", timeout=args.timeout)
    checks.append({
        "name": "map_health",
        "ok": health["ok"],
        "detail": f"status={health['status']}",
    })

    version = _http_json(f"{base}/api/version", timeout=args.timeout)
    payload = version.get("payload") if isinstance(version.get("payload"), dict) else {}
    commit = str(payload.get("commit") or payload.get("commitSha") or "").strip()
    expected = (args.expect_commit or "").strip().lower()
    version_ok = version["ok"] and (not expected or commit.lower() == expected)
    checks.append({
        "name": "map_version_commit",
        "ok": version_ok,
        "detail": json.dumps({
            "status": version["status"],
            "commit": commit,
            "expectedCommit": expected,
        }, ensure_ascii=False),
    })

    if not key:
        checks.append({
            "name": "map_logs_scope",
            "ok": False,
            "detail": f"missing STABLE_SMOKE RSA identity or {args.map_key_env}/PRD_AGENT_API_KEY",
        })
        return checks

    logs_url = f"{base}/api/logs/llm?" + urllib.parse.urlencode({"page": 1, "pageSize": 10})
    logs = _http_json(logs_url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}, timeout=args.timeout)
    payload = logs.get("payload") if isinstance(logs.get("payload"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    total = data.get("total") if isinstance(data, dict) else None
    logs_ok = logs["ok"] and isinstance(total, int)
    checks.append({
        "name": "map_logs_scope",
        "ok": logs_ok,
        "detail": json.dumps({
            "status": logs["status"],
            "keyEnv": key_name,
            "total": total,
            "errorCode": error.get("code"),
            "errorMessage": error.get("message"),
        }, ensure_ascii=False),
    })
    if logs_ok:
        checks.append(_direct_transport_check(args, base, key_name, key))
    return checks


def _gateway_checks(args: argparse.Namespace) -> list[dict]:
    checks: list[dict] = []
    base = (args.gw_base or os.environ.get("LLMGW_GATE_BASE") or os.environ.get("GW_BASE") or "").strip().rstrip("/")
    key_env_names = [args.gw_key_env, "LLMGW_GATE_KEY", "GW_KEY", "LLMGW_SERVE_KEY"]
    key_name, key = _env_first(key_env_names)
    if not base:
        checks.append({"name": "gateway_base_configured", "ok": False, "detail": "missing LLMGW_GATE_BASE/GW_BASE or --gw-base"})
        checks.append({
            "name": "gateway_key_configured",
            "ok": bool(key),
            "detail": f"keyEnv={key_name}" if key else f"missing {_join_unique(key_env_names)}",
        })
        return checks
    checks.append({"name": "gateway_base_configured", "ok": True, "detail": _redact_url(base)})

    health = _http_json(f"{base}/healthz", timeout=args.timeout)
    payload = health.get("payload") if isinstance(health.get("payload"), dict) else {}
    commit = str(payload.get("commit") or payload.get("commitSha") or "").strip()
    expected = (args.expect_commit or "").strip().lower()
    health_ok = health["ok"] and (not expected or commit.lower() == expected)
    checks.append({
        "name": "gateway_health_commit",
        "ok": health_ok,
        "detail": json.dumps({
            "status": health["status"],
            "commit": commit,
            "expectedCommit": expected,
        }, ensure_ascii=False),
    })

    protected = _http_json(f"{base}/send", method="POST", body=b"{}", headers={"Content-Type": "application/json"}, timeout=args.timeout)
    checks.append({
        "name": "gateway_protected_requires_key",
        "ok": protected["status"] == 401,
        "detail": f"status={protected['status']}",
    })

    if not key:
        checks.append({"name": "gateway_key_configured", "ok": False, "detail": f"missing {_join_unique(key_env_names)}"})
    else:
        checks.append({"name": "gateway_key_configured", "ok": True, "detail": f"keyEnv={key_name}"})
        route_self_test = _http_json(
            f"{base}/route-self-test",
            headers={"X-Gateway-Key": key, "Accept": "application/json"},
            timeout=args.timeout,
        )
        checks.append(_gateway_route_self_test_result(route_self_test, key_name))
    return checks


def _gateway_route_self_test_result(result: dict, key_name: str) -> dict:
    payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
    cases = payload.get("cases") if "cases" in payload else payload.get("Cases")
    if not isinstance(cases, list):
        cases = []
    protocols = sorted({
        str((item.get("ingressProtocol") if isinstance(item, dict) else "") or (item.get("IngressProtocol") if isinstance(item, dict) else "")).strip()
        for item in cases
        if isinstance(item, dict)
    })
    total = payload.get("total") if "total" in payload else payload.get("Total")
    passed = payload.get("passed") if "passed" in payload else payload.get("Passed")
    status = str(payload.get("status") if "status" in payload else payload.get("Status") or "").strip().lower()
    mode = str(payload.get("mode") if "mode" in payload else payload.get("Mode") or "").strip().lower()
    upstream_called = payload.get("upstreamCalled") if "upstreamCalled" in payload else payload.get("UpstreamCalled")
    required_protocols = {"gw-native", "openai-compatible", "claude-compatible", "gemini-compatible"}
    missing_protocols = sorted(required_protocols.difference(protocols))
    ok = (
        result.get("ok") is True
        and status == "ok"
        and mode == "dry-run"
        and upstream_called is False
        and isinstance(total, int)
        and isinstance(passed, int)
        and total == passed
        and total >= len(required_protocols)
        and not missing_protocols
    )
    detail = {
        "status": result.get("status"),
        "keyEnv": key_name,
        "selfTestStatus": status,
        "mode": mode,
        "upstreamCalled": upstream_called,
        "total": total,
        "passed": passed,
        "protocols": protocols,
        "missingProtocols": missing_protocols,
    }
    if not ok:
        detail["likelyCause"], detail["nextAction"] = _diagnose_route_self_test_failure(
            status_code=result.get("status"),
            key_name=key_name,
            total=total,
            passed=passed,
            missing_protocols=missing_protocols,
        )
    return {
        "name": "gateway_route_self_test",
        "ok": ok,
        "detail": json.dumps(detail, ensure_ascii=False),
    }


def _diagnose_route_self_test_failure(
    status_code: object,
    key_name: str,
    total: object,
    passed: object,
    missing_protocols: list[str],
) -> tuple[str, str]:
    """把 route-self-test 失败收敛成一个主要原因 + 一条恢复动作。

    对齐 rule.platform.production-release-safety §5「错误必须收敛为一个主要原因」。
    没有这段归因时，操作者看到的只有 `"ok": false` 和一个裸状态码，无法区分
    「网关真的坏了」和「预检的凭据跟运行态对不上」——2026-07-30 就是在这里
    连烧两次生产发布 run 才定位到根因。

    401 尤其要说清楚：它几乎不代表网关不可用（同一轮预检里 gateway_health_commit
    与 gateway_protected_requires_key 都是 pass），而是**预检持有的 key 与运行中
    serving 容器持有的 `LlmGwServe__ApiKey` 不是同一个值**——典型场景是 `.env`
    已经轮换成新 key，但持 key 容器从未随之重建，仍带着旧值。

    这里还藏着一个死锁，必须在提示里点破：本预检在 `exec_dep.sh` **之前**运行
    （操作者先预检、再发布），判定用的是**发布前**的运行态；而这次发布走到 compose up 时恰恰会用新 `.env` 重建容器、
    自动消解这个不一致。于是「上一次没做完的轮换」把「本可以修好它的这次发布」
    永久挡在门外，反复重试同一条 run 只会反复烧在同一处。正确处置是先补完轮换
    （重建持 key 容器）再发布，而不是重试或调大超时。
    """
    if status_code == 401 or status_code == 403:
        return (
            f"网关拒绝了预检使用的 X-Gateway-Key（{key_name}，HTTP {status_code}）。"
            "同轮 gateway_health_commit / gateway_protected_requires_key 若为 pass，"
            "说明网关服务本身健康，问题是凭据与运行态不一致："
            "最常见的是 .env 的 LLMGW_SERVE_KEY 已轮换，但持 key 容器"
            "（llmgw-serve / llmgw-serve-b / api）从未随之重建，仍带着旧 key。",
            "先补完这次轮换再发布：在生产机执行 "
            "`docker compose --env-file .env up -d --no-deps --force-recreate "
            "llmgw-serve-b llmgw-serve llmgw api`，容器 healthy 后重跑发布。"
            "注意本预检在部署之前运行，判定的是发布前的运行态，"
            "所以重试同一条 run 不会自愈；重建非 gateway 容器后还需原地 "
            "`nginx -s reload` 刷新 gateway 缓存的上游地址，否则公网会 502。",
        )
    if not isinstance(status_code, int) or status_code == 0 or status_code >= 500:
        return (
            f"网关 /route-self-test 未返回可用响应（status={status_code}），"
            "serving 可能未就绪、正在重启或被上游代理拦截。",
            "先确认 llmgw-serve 与 llmgw-serve-b 容器 running 且 healthy、"
            "gateway 的上游地址是最新的，再重跑发布。",
        )
    if missing_protocols:
        return (
            "网关缺少必需的入口协议：" + "、".join(missing_protocols) + "。"
            "通常表示当前运行的 serving 版本早于本次要发布的 commit。",
            "确认 llmgw-serve 运行的镜像 tag 与目标 commit 一致；"
            "若是首次引入该协议，先发布包含该协议的 serving 版本再重跑预检。",
        )
    if isinstance(total, int) and isinstance(passed, int) and total != passed:
        return (
            f"路由自检有用例未通过（passed={passed}/total={total}），"
            "属于网关自身的路由/模型池配置问题，不是凭据问题。",
            "读取 /route-self-test 响应里失败用例的 ingressProtocol 与原因，"
            "修好配置后重跑；不要用重试或调大超时绕过。",
        )
    return (
        "路由自检未达成放行条件（要求 status=ok、mode=dry-run、upstreamCalled=false、"
        "四协议全部通过）。",
        "查看本条 detail 中的各字段定位偏差项，修复后重跑发布。",
    )


def _self_test() -> int:
    ready = _gateway_route_self_test_result({
        "ok": True,
        "status": 200,
        "payload": {
            "Status": "ok",
            "Mode": "dry-run",
            "UpstreamCalled": False,
            "Total": 4,
            "Passed": 4,
            "Cases": [
                {"IngressProtocol": "gw-native"},
                {"IngressProtocol": "openai-compatible"},
                {"IngressProtocol": "claude-compatible"},
                {"IngressProtocol": "gemini-compatible"},
            ],
        },
    }, "TEST_KEY")
    blocked = _gateway_route_self_test_result({
        "ok": True,
        "status": 200,
        "payload": {
            "Status": "ok",
            "Mode": "dry-run",
            "UpstreamCalled": False,
            "Total": 3,
            "Passed": 3,
            "Cases": [
                {"IngressProtocol": "gw-native"},
                {"IngressProtocol": "openai-compatible"},
                {"IngressProtocol": "claude-compatible"},
            ],
        },
    }, "TEST_KEY")
    if ready.get("ok") is not True or blocked.get("ok") is not False:
        print("LLM Gateway prod preflight self-test: FAIL", file=sys.stderr)
        print(json.dumps({"ready": ready, "blocked": blocked}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    print("LLM Gateway prod preflight self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway production preflight")
    parser.add_argument("--map-base", default="", help="MAP base URL; falls back to PRD_AGENT_BASE.")
    parser.add_argument("--map-key-env", default="PRD_AGENT_API_KEY")
    parser.add_argument("--gw-base", default="")
    parser.add_argument("--gw-key-env", default="LLMGW_GATE_KEY")
    parser.add_argument("--expect-commit", default="", help="MAP /api/version 与网关 /healthz 必须报告的 commit；留空则不比对。")
    parser.add_argument("--direct-transport-since-hours", type=float, default=float(os.environ.get("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS", "24")))
    parser.add_argument("--direct-transport-page-size", type=int, default=int(os.environ.get("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE", "200")))
    parser.add_argument("--direct-transport-max-pages", type=int, default=int(os.environ.get("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES", "10")))
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_PROD_PREFLIGHT_JSON_OUT", ""))
    parser.add_argument("--self-test", action="store_true", help="离线验证 route-self-test gate 解析逻辑，不访问网络")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    checks = []
    checks.extend(_map_checks(args))
    checks.extend(_gateway_checks(args))

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "pass" if all(item.get("ok") for item in checks) else "fail",
        "expectCommit": args.expect_commit,
        "checks": checks,
    }
    if args.json_out:
        path = Path(args.json_out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
