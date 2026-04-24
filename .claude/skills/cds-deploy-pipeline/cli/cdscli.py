#!/usr/bin/env python3
"""
cdscli — CDS 管理 CLI (MVP)

为 AI agent 封装 CDS REST API，避免在 bash 里手写 curl 的典型坑：
  - 嵌套 JSON 转义（container-exec body 里带 curl 命令）
  - Bash 工具调用之间 shell 变量丢失（token 失效 → 401）
  - SSE 流解析（self-update、deploy 输出要逐行拆）
  - 多端点组合场景（诊断 = 状态+日志+env+history 四次 GET）

用法:
  cdscli <command> [subcommand] [args] [flags]
  cdscli --help

环境变量 (从 shell profile 读取，CLI 不做加密):
  CDS_HOST          必填。如 cds.miduo.org（https 自动前缀）
  AI_ACCESS_KEY     bootstrap 静态密钥，与 CDS 服务端 process.env 一致
  CDS_PROJECT_KEY   (可选) 项目级 cdsp_* 通行证，覆盖 AI_ACCESS_KEY
  CDS_PROJECT_ID    (可选) 配 CDS_PROJECT_KEY 使用，用于默认项目作用域
  MAP_AI_USER       (可选) 后端 API 认证的 X-AI-Impersonate

输出模式:
  默认 JSON (stdout: {ok, data|error})，方便 AI agent jq / python -c 解析
  --human 输出人读表格
  --trace <id> 跟踪 ID 透传到每条 log 行（默认随机 8 hex）

退出码:
  0 成功; 1 用户错误 (参数 / 网络); 2 CDS 返回 4xx; 3 CDS 返回 5xx
"""
from __future__ import annotations
import argparse
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

VERSION = "0.1.0"
_TRACE_ID: str = ""
_HUMAN: bool = False


# ── HTTP helpers ───────────────────────────────────────────────────

def _cds_base() -> str:
    host = os.environ.get("CDS_HOST", "").strip()
    if not host:
        die("CDS_HOST 未设置。请 export CDS_HOST=cds.miduo.org", code=1)
    if not host.startswith("http"):
        host = "https://" + host
    return host.rstrip("/")


def _auth_headers() -> dict[str, str]:
    # Cloudflare bans the default `Python-urllib/3.x` UA with error 1010
    # (browser_signature_banned). Present a curl-like UA so CF lets us
    # through — this is exactly the kind of platform-edge-case the CLI
    # centralizes so every caller benefits from the fix.
    h: dict[str, str] = {"User-Agent": "curl/8.5.0"}
    pk = os.environ.get("CDS_PROJECT_KEY", "").strip()
    if pk:
        h["X-AI-Access-Key"] = pk
        return h
    ak = os.environ.get("AI_ACCESS_KEY", "").strip()
    if ak:
        h["X-AI-Access-Key"] = ak
        return h
    # No auth available — caller will hit 401 on protected endpoints.
    return h


def _request(method: str, path: str, body: Any = None, timeout: int = 15,
             extra_headers: dict[str, str] | None = None) -> tuple[int, Any, dict[str, str]]:
    """Low-level HTTP: returns (status, parsed_json_or_text, headers)."""
    url = _cds_base() + path
    headers = {"Accept": "application/json", **_auth_headers()}
    if extra_headers:
        headers.update(extra_headers)
    data: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            parsed: Any = raw
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                pass
            return resp.status, parsed, dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        parsed = raw
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            pass
        return e.code, parsed, dict(e.headers or {})
    except urllib.error.URLError as e:
        die(f"网络错误: {e.reason} (host={url})", code=1)
    except TimeoutError:
        die(f"请求超时: {method} {url} (timeout={timeout}s)", code=1)


def _call(method: str, path: str, body: Any = None, timeout: int = 15,
          quiet: bool = False) -> Any:
    """High-level HTTP: returns parsed body on 2xx, exits with code on error."""
    status, parsed, _hdrs = _request(method, path, body=body, timeout=timeout)
    if 200 <= status < 300:
        return parsed
    if quiet:
        return {"__error__": True, "status": status, "body": parsed}
    code = 2 if 400 <= status < 500 else 3
    msg = parsed
    if isinstance(parsed, dict):
        msg = parsed.get("message") or parsed.get("error") or parsed
    die(f"HTTP {status}: {msg}", code=code, extra={"status": status, "body": parsed})


# ── I/O ────────────────────────────────────────────────────────────

def die(msg: str, *, code: int = 1, extra: dict[str, Any] | None = None) -> None:
    """Unified error exit. Writes JSON {ok:false, error, trace} to stdout."""
    payload: dict[str, Any] = {"ok": False, "error": msg, "trace": _TRACE_ID}
    if extra:
        payload.update(extra)
    if _HUMAN:
        print(f"✗ {msg}", file=sys.stderr)
    else:
        print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def ok(data: Any = None, *, note: str | None = None) -> None:
    """Unified success exit."""
    if _HUMAN:
        if note:
            print(f"✓ {note}")
        if data is not None and not isinstance(data, bool):
            if isinstance(data, (dict, list)):
                print(json.dumps(data, ensure_ascii=False, indent=2))
            else:
                print(data)
    else:
        payload: dict[str, Any] = {"ok": True, "trace": _TRACE_ID}
        if note:
            payload["note"] = note
        if data is not None:
            payload["data"] = data
        print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)


# ── Commands ───────────────────────────────────────────────────────

def cmd_health(args: argparse.Namespace) -> None:
    status, body, _ = _request("GET", "/healthz", timeout=5)
    ok({"status": status, "body": body}, note=f"healthz={status}")


def cmd_auth_check(args: argparse.Namespace) -> None:
    """验证当前认证是否能通过 CDS。"""
    hdrs = _auth_headers()
    if not hdrs:
        die("没有可用的认证凭据（CDS_PROJECT_KEY 或 AI_ACCESS_KEY）", code=1)
    which = "CDS_PROJECT_KEY" if "CDS_PROJECT_KEY" in os.environ else "AI_ACCESS_KEY"
    status, body, _ = _request("GET", "/api/config", timeout=5)
    if 200 <= status < 300:
        ok({"method": which, "status": status, "configKeys": list(body.keys())[:5] if isinstance(body, dict) else None},
           note=f"认证通过 via {which}")
    die(f"认证失败: {status} {body}", code=2)


def cmd_project_list(args: argparse.Namespace) -> None:
    body = _call("GET", "/api/projects")
    projects = body.get("projects", [])
    if _HUMAN:
        print(f"{len(projects)} 个项目:")
        for p in projects:
            print(f"  - {p.get('id','?'):20s} {p.get('name','?')} "
                  f"br={p.get('branchCount','?')} "
                  f"run={p.get('runningServiceCount','-')} "
                  f"lastDeploy={p.get('lastDeployedAt','-')}")
        return
    ok(projects)


def cmd_project_show(args: argparse.Namespace) -> None:
    body = _call("GET", f"/api/projects/{urllib.parse.quote(args.id)}")
    ok(body)


def cmd_project_stats(args: argparse.Namespace) -> None:
    """Condensed runtime snapshot (从 /api/projects 摘字段)."""
    body = _call("GET", "/api/projects")
    for p in body.get("projects", []):
        if p.get("id") == args.id:
            ok({
                "id": p.get("id"),
                "name": p.get("name"),
                "branchCount": p.get("branchCount"),
                "runningBranchCount": p.get("runningBranchCount"),
                "runningServiceCount": p.get("runningServiceCount"),
                "lastDeployedAt": p.get("lastDeployedAt"),
            })
    die(f"项目不存在: {args.id}", code=2)


def cmd_branch_list(args: argparse.Namespace) -> None:
    path = "/api/branches"
    project = args.project or os.environ.get("CDS_PROJECT_ID", "")
    if project:
        path += f"?project={urllib.parse.quote(project)}"
    body = _call("GET", path, timeout=30)
    branches = body.get("branches", [])
    if _HUMAN:
        cap = body.get("capacity", {})
        print(f"容量: {cap.get('runningContainers','?')}/{cap.get('maxContainers','?')} "
              f"({cap.get('totalMemGB','?')}GB)")
        print(f"{len(branches)} 个分支:")
        for b in branches:
            svcs = ",".join(f"{k}:{v.get('status','?')}" for k, v in (b.get("services") or {}).items())
            print(f"  - {b.get('id','?'):40s} {b.get('status','?'):10s} {svcs}")
        return
    ok({"branches": branches, "capacity": body.get("capacity")})


def cmd_branch_status(args: argparse.Namespace) -> None:
    body = _call("GET", "/api/branches", timeout=30)
    for b in body.get("branches", []):
        if b.get("id") == args.id:
            ok(b)
    die(f"分支不存在: {args.id}", code=2)


def cmd_branch_deploy(args: argparse.Namespace) -> None:
    """触发 /api/branches/:id/deploy，SSE 截断后轮询状态直到稳定。"""
    branch_id = args.id
    # Trigger (SSE; we don't read the full stream — a short max-wait is enough)
    _request("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/deploy", timeout=5)
    time.sleep(3)  # 状态更新延迟，按 skill 实战经验
    deadline = time.time() + args.timeout
    last_status = None
    while time.time() < deadline:
        body = _call("GET", "/api/branches", timeout=30, quiet=True)
        if isinstance(body, dict) and body.get("__error__"):
            time.sleep(5)
            continue
        for b in body.get("branches", []):
            if b.get("id") != branch_id:
                continue
            last_status = b.get("status")
            if last_status in ("running", "error"):
                ok({"status": last_status, "services": b.get("services"), "errorMessage": b.get("errorMessage")},
                   note=f"部署 {last_status}")
        time.sleep(5)
    die(f"部署超时（{args.timeout}s），最近状态: {last_status}", code=2)


def cmd_branch_logs(args: argparse.Namespace) -> None:
    body = _call("POST", f"/api/branches/{urllib.parse.quote(args.id)}/container-logs",
                 body={"profileId": args.profile}, timeout=30)
    logs = body.get("logs", "") if isinstance(body, dict) else str(body)
    if _HUMAN:
        print(logs[-args.tail * 200:] if args.tail else logs)
        return
    ok({"logs": logs, "lines": logs.count("\n")})


def cmd_branch_exec(args: argparse.Namespace) -> None:
    """容器内执行命令——把 curl 之类复杂字符串塞进 JSON 而不用 bash 转义。"""
    body = _call("POST", f"/api/branches/{urllib.parse.quote(args.id)}/container-exec",
                 body={"profileId": args.profile, "command": args.command},
                 timeout=args.timeout)
    ok(body)


def cmd_branch_history(args: argparse.Namespace) -> None:
    body = _call("GET", f"/api/branches/{urllib.parse.quote(args.id)}/logs", timeout=10)
    # Only emit last operation by default to avoid swamping context
    recent = body[-args.limit:] if isinstance(body, list) and args.limit > 0 else body
    ok(recent)


def cmd_env_get(args: argparse.Namespace) -> None:
    scope = args.scope or "_global"
    path = f"/api/env?scope={urllib.parse.quote(scope)}"
    body = _call("GET", path)
    ok(body)


def cmd_env_set(args: argparse.Namespace) -> None:
    if "=" not in args.kv:
        die("格式应为 KEY=VALUE", code=1)
    k, v = args.kv.split("=", 1)
    scope = args.scope or "_global"
    body = _call("PUT", f"/api/env/{urllib.parse.quote(k)}?scope={urllib.parse.quote(scope)}",
                 body={"value": v})
    ok(body, note=f"set {k} in scope={scope}")


def cmd_self_branches(args: argparse.Namespace) -> None:
    body = _call("GET", "/api/self-branches", timeout=10)
    ok(body)


def cmd_self_update(args: argparse.Namespace) -> None:
    """SSE 流 → 把每个 event 打印出来（聚合成列表），等待 CDS 重启后回读。"""
    payload = {"branch": args.branch} if args.branch else {}
    url = _cds_base() + "/api/self-update"
    headers = {"Content-Type": "application/json", **_auth_headers()}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, method="POST", data=data, headers=headers)
    events: list[dict[str, Any]] = []
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            cur_event = None
            for line_bytes in resp:
                line = line_bytes.decode("utf-8", errors="replace").rstrip()
                if line.startswith("event: "):
                    cur_event = line[7:]
                elif line.startswith("data: "):
                    try:
                        parsed = json.loads(line[6:])
                    except (json.JSONDecodeError, ValueError):
                        parsed = {"raw": line[6:]}
                    if cur_event:
                        parsed["_event"] = cur_event
                    events.append(parsed)
                    if cur_event in ("done", "error"):
                        break
    except urllib.error.HTTPError as e:
        die(f"self-update HTTP {e.code}: {e.read().decode('utf-8','replace')[:200]}", code=2)
    except (urllib.error.URLError, TimeoutError) as e:
        # 连接断开是正常的，CDS 重启时流会被 kill
        pass
    if not args.no_wait:
        # Poll healthz until CDS is back (max 60s)
        for _ in range(12):
            time.sleep(5)
            status, _b, _h = _request("GET", "/healthz", timeout=5)
            if status == 200:
                break
        else:
            die("CDS 未能在 60s 内恢复", code=3, extra={"events": events})
    ok({"events": events, "restarted": not args.no_wait}, note="self-update 完成")


def cmd_global_key_list(args: argparse.Namespace) -> None:
    body = _call("GET", "/api/global-agent-keys")
    ok(body)


def cmd_global_key_create(args: argparse.Namespace) -> None:
    body = _call("POST", "/api/global-agent-keys", body={"label": args.label or ""})
    # 明文一次性显示
    ok(body, note="已签发全局通行证（明文只显示一次）")


def cmd_key_list(args: argparse.Namespace) -> None:
    project = args.project or os.environ.get("CDS_PROJECT_ID", "")
    if not project:
        die("需要 --project 或 CDS_PROJECT_ID", code=1)
    body = _call("GET", f"/api/projects/{urllib.parse.quote(project)}/agent-keys")
    ok(body)


def cmd_diagnose(args: argparse.Namespace) -> None:
    """一键诊断：状态 + 容器日志 + env + 最近 history。
    取代技能里"场景 2"的 5-6 条 curl，避免跨 Bash 调用变量丢失。
    """
    branch_id = args.id
    out: dict[str, Any] = {"branchId": branch_id, "trace": _TRACE_ID}

    # 1. 状态
    body = _call("GET", "/api/branches", timeout=30, quiet=True)
    match = None
    if isinstance(body, dict) and not body.get("__error__"):
        for b in body.get("branches", []):
            if b.get("id") == branch_id:
                match = b
                break
    out["status"] = match.get("status") if match else "unknown"
    out["services"] = match.get("services") if match else None
    out["errorMessage"] = match.get("errorMessage") if match else None

    # 2. 每个 profile 的容器日志（失败优先取 tail）
    out["logs"] = {}
    profiles = list((match or {}).get("services", {}).keys()) or ["api", "admin"]
    for pid in profiles[:args.max_profiles]:
        logs_body = _call("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/container-logs",
                          body={"profileId": pid}, timeout=15, quiet=True)
        if isinstance(logs_body, dict) and logs_body.get("__error__"):
            out["logs"][pid] = f"<logs unavailable: {logs_body.get('status')}>"
        else:
            raw = logs_body.get("logs", "") if isinstance(logs_body, dict) else str(logs_body)
            lines = raw.splitlines()
            out["logs"][pid] = "\n".join(lines[-args.tail:])

    # 3. env
    env_body = _call("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/container-env",
                     body={"profileId": profiles[0] if profiles else "api"},
                     timeout=10, quiet=True)
    if isinstance(env_body, dict) and not env_body.get("__error__"):
        env_map = env_body.get("env", {}) if isinstance(env_body, dict) else {}
        # 屏蔽敏感
        out["envKeys"] = sorted(env_map.keys()) if isinstance(env_map, dict) else []

    # 4. 最近操作
    hist = _call("GET", f"/api/branches/{urllib.parse.quote(branch_id)}/logs",
                 timeout=10, quiet=True)
    if isinstance(hist, list):
        out["lastOperation"] = hist[-1] if hist else None
    ok(out, note="诊断完成")


# ── argparse wiring ────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cdscli", description="CDS 管理 CLI")
    p.add_argument("--human", action="store_true", help="人读输出")
    p.add_argument("--trace", help="链路 ID (默认随机 8 hex)")
    p.add_argument("--version", action="version", version=f"cdscli {VERSION}")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health", help="CDS /healthz").set_defaults(func=cmd_health)

    auth = sub.add_parser("auth", help="认证").add_subparsers(dest="sub", required=True)
    auth.add_parser("check", help="验证当前凭据").set_defaults(func=cmd_auth_check)

    proj = sub.add_parser("project", help="项目").add_subparsers(dest="sub", required=True)
    proj.add_parser("list").set_defaults(func=cmd_project_list)
    ps = proj.add_parser("show"); ps.add_argument("id"); ps.set_defaults(func=cmd_project_show)
    pt = proj.add_parser("stats"); pt.add_argument("id"); pt.set_defaults(func=cmd_project_stats)

    br = sub.add_parser("branch", help="分支").add_subparsers(dest="sub", required=True)
    bl = br.add_parser("list"); bl.add_argument("--project"); bl.set_defaults(func=cmd_branch_list)
    bs = br.add_parser("status"); bs.add_argument("id"); bs.set_defaults(func=cmd_branch_status)
    bd = br.add_parser("deploy"); bd.add_argument("id"); bd.add_argument("--timeout", type=int, default=300)
    bd.set_defaults(func=cmd_branch_deploy)
    blg = br.add_parser("logs"); blg.add_argument("id"); blg.add_argument("--profile", required=True)
    blg.add_argument("--tail", type=int, default=100); blg.set_defaults(func=cmd_branch_logs)
    be = br.add_parser("exec"); be.add_argument("id"); be.add_argument("--profile", required=True)
    be.add_argument("command"); be.add_argument("--timeout", type=int, default=30)
    be.set_defaults(func=cmd_branch_exec)
    bh = br.add_parser("history"); bh.add_argument("id"); bh.add_argument("--limit", type=int, default=1)
    bh.set_defaults(func=cmd_branch_history)

    env = sub.add_parser("env", help="环境变量").add_subparsers(dest="sub", required=True)
    eg = env.add_parser("get"); eg.add_argument("--scope"); eg.set_defaults(func=cmd_env_get)
    es = env.add_parser("set"); es.add_argument("kv", help="KEY=VALUE"); es.add_argument("--scope")
    es.set_defaults(func=cmd_env_set)

    slf = sub.add_parser("self", help="CDS 自身").add_subparsers(dest="sub", required=True)
    slf.add_parser("branches").set_defaults(func=cmd_self_branches)
    su = slf.add_parser("update"); su.add_argument("--branch")
    su.add_argument("--no-wait", action="store_true", help="不等 CDS 重启")
    su.set_defaults(func=cmd_self_update)

    gk = sub.add_parser("global-key", help="全局通行证").add_subparsers(dest="sub", required=True)
    gk.add_parser("list").set_defaults(func=cmd_global_key_list)
    gkc = gk.add_parser("create"); gkc.add_argument("--label"); gkc.set_defaults(func=cmd_global_key_create)

    kc = sub.add_parser("key", help="项目级 Agent Key").add_subparsers(dest="sub", required=True)
    kl = kc.add_parser("list"); kl.add_argument("--project"); kl.set_defaults(func=cmd_key_list)

    dg = sub.add_parser("diagnose", help="一键诊断分支"); dg.add_argument("id")
    dg.add_argument("--tail", type=int, default=80)
    dg.add_argument("--max-profiles", type=int, default=4)
    dg.set_defaults(func=cmd_diagnose)

    return p


def main(argv: list[str] | None = None) -> None:
    global _TRACE_ID, _HUMAN
    parser = _build_parser()
    args = parser.parse_args(argv)
    _TRACE_ID = args.trace or secrets.token_hex(4)
    _HUMAN = args.human
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        sys.exit(1)
    func(args)


if __name__ == "__main__":
    main()
