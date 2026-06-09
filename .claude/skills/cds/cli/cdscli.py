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
import http.client  # noqa: F401  -- 用于 IncompleteRead 类型捕获
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

VERSION = "0.6.7"  # ← bumped on each SKILL.md change; 服务端自动读这一行
_TRACE_ID: str = ""
_HUMAN: bool = False
_DRIFT_WARNED: bool = False  # 全进程只提示一次，避免每个请求都刷
_GENERIC_WORKSPACE_SLUGS = {
    "workspace",
    "cursor-workspace",
    "codex-workspace",
    "project",
    "repo",
    "repository",
    "source",
    "src",
    "app",
}


# ── HTTP helpers ───────────────────────────────────────────────────

def _cds_base() -> str:
    host = os.environ.get("CDS_HOST", "").strip()
    if not host:
        die("CDS_HOST 未设置。请 export CDS_HOST=cds.miduo.org", code=1)
    if not host.startswith("http"):
        # 本机/localhost/IP 默认 http(无 TLS),公网域名默认 https
        # 用户可以显式 export CDS_HOST=http://xxx 或 https://xxx 覆盖。
        is_local = (
            host.startswith("localhost")
            or host.startswith("127.")
            or host.startswith("0.0.0.0")
            or host.startswith("[::1]")
            or host.startswith("192.168.")
            or host.startswith("10.")
            or host.startswith("172.")
        )
        host = ("http://" if is_local else "https://") + host
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
    """Low-level HTTP: returns (status, parsed_json_or_text, headers).

    每个请求都带 X-CdsCli-Version 头，服务端如响应 X-Cds-Cli-Latest 就
    做一次 stderr 提示（整进程最多一次，避免刷屏）。用户可 export
    CDSCLI_NO_DRIFT_CHECK=1 关闭提示。
    """
    url = _cds_base() + path
    headers = {
        "Accept": "application/json",
        "X-CdsCli-Version": VERSION,
        **_auth_headers(),
    }
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
            _maybe_warn_version_drift(dict(resp.headers))
            return resp.status, parsed, dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        parsed = raw
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            pass
        _maybe_warn_version_drift(dict(e.headers or {}))
        return e.code, parsed, dict(e.headers or {})
    except urllib.error.URLError as e:
        die(f"网络错误: {e.reason} (host={url})", code=1)
    except TimeoutError:
        die(f"请求超时: {method} {url} (timeout={timeout}s)", code=1)


def _request_stream_safe(method: str, path: str, body: Any = None,
                         timeout: int = 5,
                         extra_headers: dict[str, str] | None = None,
                         ) -> dict[str, Any]:
    """触发型 HTTP 调用：耐 chunked / IncompleteRead / 半流断开。

    适用场景（典型）：
      - POST /api/branches/:id/deploy  —— SSE 触发部署，服务端边写边传，
        客户端经常在写完触发动作但还没读完时被 chunked 截断，原 _request
        会抛 http.client.IncompleteRead 然后被 `urlopen` 抛出 traceback
        砸到 AI/用户面前
      - 任何"只关心已触发，不关心完整 body"的 fire-and-forget 端点

    返回结构（不抛异常，由调用方自行判定 ok）：
      {
        "triggered": bool,             # HTTP 至少握手成功就 True
        "status": int | None,          # 收到的 HTTP 状态码（None=没握手）
        "body": str | dict | None,     # best-effort 解析的 body（可能是部分字节）
        "partial": bool,               # body 是否因 IncompleteRead 截断
        "error": str | None,           # 任何被吃掉的异常的人话描述
        "errorType": str | None,       # 异常类名（用于 --debug 输出）
      }

    若 CDSCLI_DEBUG=1 已设置，调用方可决定是否把 traceback 打到 stderr ——
    此函数本身不打印 traceback，只静默返回结构化错误。
    """
    url = _cds_base() + path
    headers = {
        "Accept": "application/json",
        "X-CdsCli-Version": VERSION,
        **_auth_headers(),
    }
    if extra_headers:
        headers.update(extra_headers)
    data: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data, headers=headers)

    result: dict[str, Any] = {
        "triggered": False,
        "status": None,
        "body": None,
        "partial": False,
        "error": None,
        "errorType": None,
    }

    debug_on = bool(os.environ.get("CDSCLI_DEBUG", "").strip())

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result["triggered"] = True
            result["status"] = resp.status
            try:
                raw_bytes = resp.read()
                raw = raw_bytes.decode("utf-8", errors="replace")
                _try_parse_into_result(result, raw)
            except http.client.IncompleteRead as ir:
                # chunked 流半截断：服务端已经接受了请求并开始处理，
                # 我们已经拿到部分 body —— 视作触发成功
                result["partial"] = True
                result["error"] = "incomplete_read"
                result["errorType"] = "http.client.IncompleteRead"
                partial_bytes = getattr(ir, "partial", b"") or b""
                if partial_bytes:
                    raw = partial_bytes.decode("utf-8", errors="replace")
                    _try_parse_into_result(result, raw)
                if debug_on:
                    print(f"[cdscli debug] _request_stream_safe IncompleteRead "
                          f"on {method} {path}; partial={len(partial_bytes)} bytes",
                          file=sys.stderr)
            _maybe_warn_version_drift(dict(resp.headers))
    except urllib.error.HTTPError as e:
        # HTTP 错误码（4xx/5xx）—— 服务端有响应，已触发但有问题
        result["triggered"] = True
        result["status"] = e.code
        try:
            raw = e.read().decode("utf-8", errors="replace")
            _try_parse_into_result(result, raw)
        except (http.client.IncompleteRead, OSError):
            result["partial"] = True
        result["error"] = f"http_{e.code}"
        result["errorType"] = type(e).__name__
        _maybe_warn_version_drift(dict(e.headers or {}))
    except http.client.IncompleteRead as ir:
        # 极少见：在 with-block 之外抛出（连接级问题）
        result["triggered"] = True  # 保守视为已触发
        result["partial"] = True
        result["error"] = "incomplete_read_outer"
        result["errorType"] = "http.client.IncompleteRead"
        partial_bytes = getattr(ir, "partial", b"") or b""
        if partial_bytes:
            raw = partial_bytes.decode("utf-8", errors="replace")
            _try_parse_into_result(result, raw)
    except urllib.error.URLError as e:
        result["error"] = f"network_error: {e.reason}"
        result["errorType"] = type(e).__name__
    except (TimeoutError, socket.timeout):
        # 触发型请求 timeout 也常见 —— 可能服务端已经接受但响应慢
        # 这里保守视为"未确认触发"，让调用方决定是否后续 polling
        result["error"] = f"timeout_{timeout}s"
        result["errorType"] = "TimeoutError"
    except OSError as e:
        # 包括 socket reset、broken pipe 等
        result["error"] = f"socket_error: {e}"
        result["errorType"] = type(e).__name__

    if debug_on and result["error"]:
        print(f"[cdscli debug] _request_stream_safe error: "
              f"{result['errorType']}: {result['error']}", file=sys.stderr)
    return result


def _try_parse_into_result(result: dict[str, Any], raw: str) -> None:
    """共享 helper：把 raw 字符串塞进 result['body']，能解析就解析为 JSON。"""
    if not raw:
        return
    try:
        result["body"] = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        result["body"] = raw  # 半截 SSE / 文本 → 原样保留


def _maybe_warn_version_drift(headers: dict[str, str]) -> None:
    """当服务端响应头带 X-Cds-Cli-Latest 且 > 本地 VERSION，stderr 提示一次。

    Python http.client 会把 header 名规范化为 Title-Case，因此既要查
    `X-Cds-Cli-Latest` 也要兜 `x-cds-cli-latest`。
    """
    global _DRIFT_WARNED
    if _DRIFT_WARNED or os.environ.get("CDSCLI_NO_DRIFT_CHECK"):
        return
    latest = (headers.get("X-Cds-Cli-Latest")
              or headers.get("x-cds-cli-latest")
              or headers.get("X-CdsCli-Latest")
              or "").strip()
    if not latest:
        return
    if _version_compare(VERSION, latest) < 0:
        _DRIFT_WARNED = True
        print(
            f"[cdscli] 提示：本地版本 {VERSION} 落后于 CDS 提供的 {latest}。"
            f"运行 `cdscli update` 升级（或 (zip) Dashboard 重新下载）。"
            f"关闭提示: export CDSCLI_NO_DRIFT_CHECK=1",
            file=sys.stderr,
        )


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
        print(f"[FAIL] {msg}", file=sys.stderr)
    else:
        print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def ok(data: Any = None, *, note: str | None = None) -> None:
    """Unified success exit."""
    if _HUMAN:
        if note:
            print(f"[OK] {note}")
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


_PROJECT_SENSITIVE_FIELDS = (
    "customEnv", "agentKeys", "oauthClientSecret", "accessToken",
    "refreshToken", "webhookSecret", "pat", "password", "secret",
)


def _redact_project(p: dict, include_sensitive: bool = False) -> dict:
    """默认隐藏敏感字段，避免 AI 在日志/对话里误暴露 secret。"""
    if include_sensitive or not isinstance(p, dict):
        return p
    result = dict(p)
    for field in _PROJECT_SENSITIVE_FIELDS:
        if field in result:
            val = result[field]
            if isinstance(val, dict):
                result[field] = {k: "***" for k in val}
            elif isinstance(val, list):
                result[field] = ["***"] * len(val)
            elif val:
                result[field] = "***"
    return result


def cmd_project_list(args: argparse.Namespace) -> None:
    body = _call("GET", "/api/projects")
    projects = body.get("projects", [])
    include_sensitive = getattr(args, "include_sensitive", False)
    if _HUMAN:
        print(f"{len(projects)} 个项目:")
        for p in projects:
            print(f"  - {p.get('id','?'):20s} {p.get('name','?')} "
                  f"br={p.get('branchCount','?')} "
                  f"run={p.get('runningServiceCount','-')} "
                  f"lastDeploy={p.get('lastDeployedAt','-')}")
        if not include_sensitive:
            print("  (敏感字段已隐藏，--include-sensitive 显示全部)")
        return
    ok([_redact_project(p, include_sensitive) for p in projects])


def cmd_project_show(args: argparse.Namespace) -> None:
    body = _call("GET", f"/api/projects/{urllib.parse.quote(args.id)}")
    include_sensitive = getattr(args, "include_sensitive", False)
    ok(_redact_project(body, include_sensitive))


def cmd_project_create(args: argparse.Namespace) -> None:
    """创建空项目骨架。后端 POST /api/projects 接受 { name, gitRepoUrl, slug?, description? }。

    onboarding F3 friction:之前主智能体 UAT 时被迫直接 curl POST /api/projects,
    现在统一封装在这里。--git-url 可选(允许后续 `clone`),--slug 可选
    (后端自动从 name slugify)。
    """
    if not args.name or not args.name.strip():
        die("--name 必填", code=1)
    payload: dict[str, Any] = {"name": args.name.strip()}
    if args.git_url:
        payload["gitRepoUrl"] = args.git_url.strip()
    if args.slug:
        payload["slug"] = args.slug.strip()
    if args.description:
        payload["description"] = args.description.strip()
    body = _call("POST", "/api/projects", body=payload, timeout=30)
    proj = body.get("project") if isinstance(body, dict) else None
    if proj and _HUMAN:
        pid = proj.get("id", "?")
        slug = proj.get("slug", "?")
        print(f"[OK] 已创建项目 {slug} id={pid}")
        if proj.get("gitRepoUrl"):
            print(f"  git: {proj['gitRepoUrl']}")
        return
    ok({"project": proj or body},
       note=f"已创建项目 {(proj or {}).get('slug','?')} "
            f"id={(proj or {}).get('id','?')}")


def cmd_project_clone(args: argparse.Namespace) -> None:
    """触发 git clone(SSE 流式)。POST /api/projects/:id/clone 的事件名:
    progress / detect / profile / env-meta / done / error 等不一而足,这里
    无差别 capture,human 模式逐行回显。
    """
    pid = args.id
    url = _cds_base() + f"/api/projects/{urllib.parse.quote(pid)}/clone"
    headers = {"Accept": "text/event-stream", **_auth_headers()}
    req = urllib.request.Request(url, method="POST",
                                 data=b"", headers=headers)
    events: list[dict[str, Any]] = []
    final_event: str | None = None
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            cur_event: str | None = None
            for line_bytes in resp:
                line = line_bytes.decode("utf-8", errors="replace").rstrip()
                if not line:
                    continue
                if line.startswith("event: "):
                    cur_event = line[7:].strip() or None
                    continue
                if line.startswith("data: "):
                    raw = line[6:]
                    try:
                        parsed = json.loads(raw)
                    except (json.JSONDecodeError, ValueError):
                        parsed = {"raw": raw}
                    if cur_event:
                        parsed["_event"] = cur_event
                    events.append(parsed)
                    if _HUMAN:
                        # 友好回显:type=msg / pct / fileCount 等不固定字段
                        msg = (parsed.get("message")
                               or parsed.get("phase")
                               or parsed.get("step")
                               or parsed.get("raw")
                               or "")
                        pct = parsed.get("percent") or parsed.get("pct")
                        prefix = f"[{cur_event or 'data'}]"
                        if pct is not None:
                            print(f"{prefix} {pct}% {msg}".rstrip())
                        else:
                            print(f"{prefix} {msg}".rstrip())
                    if cur_event in ("done", "error", "complete", "fail"):
                        final_event = cur_event
                        break
    except urllib.error.HTTPError as e:
        die(f"clone HTTP {e.code}: "
            f"{e.read().decode('utf-8','replace')[:200]}", code=2)
    except (urllib.error.URLError, TimeoutError) as e:
        # Codex review fix(PR #522)— 网络中断/超时在 done/complete 之前发生时,
        # 只在已经收到 done/complete 时才视为正常成功(流断 = service 发完后服务端
        # 立刻断 keep-alive,常见);否则必须 die,不能把"事件流半途断了"当成功。
        # `error`/`fail` 事件不走此路径(它们在 line 321 break 后正常落 final_event,
        # 由下面的 ok({success:false}) 透出 — 这是结构化失败,与"流断"不同)。
        if not events:
            die(f"clone 流读取失败: {e}", code=3)
        if final_event not in ("done", "complete"):
            die(f"clone 流被中断: {e}; final_event={final_event!r} "
                f"(期望 done/complete);事件总数 {len(events)}", code=2)

    success = (final_event != "error" and final_event != "fail")
    ok({"events": events, "finalEvent": final_event, "projectId": pid,
        "success": success},
       note=f"clone 完成 ({final_event or '?'})" if success
            else f"clone 失败 ({final_event})")


def cmd_project_delete(args: argparse.Namespace) -> None:
    """级联删除项目。后端会级联清 branches/buildProfiles/infraServices/routingRules。

    无需用户确认 — 主智能体已经在调用前判断过。脚本类调用方应自己确认。
    """
    pid = args.id
    body = _call("DELETE", f"/api/projects/{urllib.parse.quote(pid)}",
                 timeout=60)
    cascade = body.get("cascade") if isinstance(body, dict) else None
    if _HUMAN and isinstance(cascade, dict):
        parts = [f"{k}={v}" for k, v in cascade.items()]
        print(f"[OK] 已删除项目 {pid};级联清理: " + ", ".join(parts))
        return
    ok({"projectId": pid, "cascade": cascade or {}},
       note=f"已删除项目 {pid}")


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
    """触发 /api/branches/:id/deploy，SSE 截断后轮询状态直到稳定。

    输出契约（issue #554 修复——禁止把 IncompleteRead traceback 透给用户）：
      成功:  {ok: true, data: {stage: "deployed", branchStatus: "running",
                                services: [...], elapsed: N, ...}}
      失败:  {ok: false, error: "<reason>", data: {stage, branchStatus, ...}}

    stage 枚举:
      deploy_blocked_pending_import — 项目有 pending 待批准 import,先批准
      deploy_trigger_failed         — 触发请求都没握手成功（网络/凭据）
      deployed                       — branchStatus=running 即视为成功
      deploy_failed                 — branchStatus=error
      building_timeout              — 超时但 status 仍在中间态（building / pulling）
    """
    branch_id = args.id

    # Step 0: 项目级守门 —— 有未批准 pending-import 时禁止 deploy（issue #553 关联）
    # 只在能查到 branch 对应 project 时做，无 project / 无端点时跳过（best effort）
    pending_block = _check_blocking_pending_import(branch_id)
    if pending_block:
        die(pending_block["error"], code=2,
            extra={"data": {**pending_block,
                            "stage": "deploy_blocked_pending_import"}})

    # Step 1: 安全触发 deploy —— IncompleteRead 不再抛 traceback
    deploy_path = f"/api/branches/{urllib.parse.quote(branch_id)}/deploy"
    trigger = _request_stream_safe("POST", deploy_path, timeout=5)

    # 触发失败,或者 HTTP 4xx/5xx (auth/not found/服务器错误)——立刻 fail,不进 300s 轮询
    trigger_status = trigger.get("status")
    trigger_http_error = isinstance(trigger_status, int) and trigger_status >= 400
    if not trigger["triggered"] or trigger_http_error:
        die(f"deploy 触发失败: {trigger.get('error') or f'http_{trigger_status}' or 'unknown'}",
            code=2 if trigger_status and trigger_status < 500 else 3,
            extra={
                "data": {
                    "stage": "deploy_trigger_failed",
                    "branchId": branch_id,
                    "triggerStatus": trigger_status,
                    "triggerBody": trigger.get("body"),
                    "triggerError": trigger.get("error"),
                    "errorType": trigger.get("errorType"),
                    "partial": trigger.get("partial", False),
                },
            })

    # Step 2: 轮询分支状态收敛
    started_at = time.time()
    time.sleep(3)  # 状态更新延迟，按 skill 实战经验
    deadline = started_at + args.timeout
    last_status: str | None = None
    last_branch: dict[str, Any] | None = None
    while time.time() < deadline:
        body = _call("GET", "/api/branches", timeout=30, quiet=True)
        if isinstance(body, dict) and body.get("__error__"):
            time.sleep(5)
            continue
        for b in body.get("branches", []):
            if b.get("id") != branch_id:
                continue
            last_status = b.get("status")
            last_branch = b
            if last_status in ("running", "error"):
                stage = "deployed" if last_status == "running" else "deploy_failed"
                payload = {
                    "stage": stage,
                    "branchStatus": last_status,
                    "branchId": branch_id,
                    "services": b.get("services"),
                    "errorMessage": b.get("errorMessage"),
                    "elapsed": int(time.time() - started_at),
                    "triggerPartial": trigger.get("partial", False),
                }
                if last_status == "running":
                    ok(payload, note=f"部署 {last_status} (stage={stage})")
                else:
                    die(f"部署失败: {b.get('errorMessage') or 'unknown'}",
                        code=2, extra={"data": payload})
        time.sleep(5)

    # Step 3: 超时
    die(f"部署超时（{args.timeout}s），最近状态: {last_status}", code=2,
        extra={
            "data": {
                "stage": "building_timeout",
                "branchStatus": last_status,
                "branchId": branch_id,
                "elapsed": int(time.time() - started_at),
                "lastBranch": last_branch,
            },
        })


def _fallback_branch_id(branch: str) -> str:
    return branch.lower().replace("/", "-")


def _resolve_deploy_branch_id(branch: str) -> str:
    """Resolve a local git branch name to the CDS branch id.

    CDS branch ids may include the project id prefix (for example
    prd-agent-codex-cds-agent-workbench-ui), so deploy must not rely on a
    slash-to-dash guess from the git branch name.
    """
    guessed = _fallback_branch_id(branch)
    body = _call("GET", "/api/branches", timeout=30)
    branches = body.get("branches", []) if isinstance(body, dict) else []

    matches = [
        b for b in branches
        if isinstance(b, dict)
        and b.get("branch") == branch
        and b.get("id")
    ]
    project_id = os.environ.get("CDS_PROJECT_ID", "").strip()
    if project_id:
        project_matches = [
            b for b in matches
            if b.get("projectId") == project_id or b.get("project") == project_id
        ]
        if len(project_matches) == 1:
            return str(project_matches[0]["id"])
        if len(project_matches) > 1:
            die(
                f"CDS_PROJECT_ID={project_id} 下分支名不唯一: {branch}",
                code=2,
                extra={
                    "data": {
                        "branch": branch,
                        "projectId": project_id,
                        "guessedBranchId": guessed,
                        "matches": [
                            {
                                "id": b.get("id"),
                                "projectId": b.get("projectId") or b.get("project"),
                            }
                            for b in project_matches
                        ],
                    }
                })
        for candidate in branches:
            if (
                isinstance(candidate, dict)
                and candidate.get("id") == guessed
                and candidate.get("branch") == branch
                and (candidate.get("projectId") == project_id or candidate.get("project") == project_id)
            ):
                return guessed
        if len(project_matches) == 0:
            die(
                f"CDS_PROJECT_ID={project_id} 下不存在分支: {branch}",
                code=2,
                extra={
                    "data": {
                        "branch": branch,
                        "projectId": project_id,
                        "guessedBranchId": guessed,
                        "matchedOtherProjects": [
                            {
                                "id": b.get("id"),
                                "projectId": b.get("projectId") or b.get("project"),
                            }
                            for b in matches
                        ],
                    }
                })

    for candidate in branches:
        if isinstance(candidate, dict) and candidate.get("id") == guessed and candidate.get("branch") == branch:
            return guessed

    if len(matches) == 1:
        return str(matches[0]["id"])

    if len(matches) > 1:
        die(
            f"CDS 分支名不唯一: {branch}，请设置 CDS_PROJECT_ID 后重试",
            code=2,
            extra={
                "data": {
                    "branch": branch,
                    "guessedBranchId": guessed,
                    "matches": [
                        {
                            "id": b.get("id"),
                            "projectId": b.get("projectId") or b.get("project"),
                        }
                        for b in matches
                    ],
                }
            })

    die(
        f"CDS 分支不存在: git branch={branch} guessedBranchId={guessed}",
        code=2,
        extra={
            "data": {
                "branch": branch,
                "guessedBranchId": guessed,
                "nextCommand": f"cdscli branch create --project <projectId> --branch {branch}",
            }
        })


def _check_blocking_pending_import(branch_id: str) -> dict[str, Any] | None:
    """查 branch → project，看 project 有没有 pending 待批准 import。

    返回阻塞信息 dict 即应当拒绝 deploy；返回 None 则放行。
    任何查询失败（端点缺失 / 网络不通 / 数据缺字段）都视为放行（best-effort 守门，
    不能反向 block 用户）。

    实现注意：这里**不能**走 _request()——它在 URLError / Timeout 时会调
    die() 退出（会先把 JSON 写到 stdout 再 SystemExit，污染主输出流）。直接
    用 urllib 自管异常。
    """
    base = _cds_base()
    headers = {"Accept": "application/json", **_auth_headers()}

    def _safe_get(path: str, timeout: int = 10) -> Any:
        try:
            req = urllib.request.Request(base + path, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if not (200 <= resp.status < 300):
                    return None
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw) if raw else None
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError, socket.timeout, OSError,
                ValueError, json.JSONDecodeError):
            return None

    body = _safe_get("/api/branches")
    if not isinstance(body, dict):
        return None
    project_id: str | None = None
    for b in body.get("branches", []):
        if isinstance(b, dict) and b.get("id") == branch_id:
            project_id = b.get("projectId") or b.get("project")
            break
    if not project_id:
        return None

    body2 = _safe_get("/api/pending-imports")
    if not isinstance(body2, dict):
        return None
    imports = body2.get("imports") or []
    if not isinstance(imports, list):
        return None
    for imp in imports:
        if not isinstance(imp, dict):
            continue
        if imp.get("projectId") != project_id:
            continue
        if imp.get("status") == "pending":
            approve_url = imp.get("approveUrl") or (
                f"{_cds_base()}/project-list?pendingImport={imp.get('id', '')}"
            )
            return {
                "ok": False,
                "error": "pending_import_not_applied",
                "message": (
                    "项目存在未批准的 pending-import，必须先批准/拒绝才能 deploy。"
                    "CDS Dashboard 任意已登录页面右下角会自动弹出'Agent 导入 N'徽章,"
                    "点击批准即可(2026-05-28 起);也可直接打开 approveUrl。"
                ),
                "importId": imp.get("id"),
                "projectId": project_id,
                "approveUrl": approve_url,
                "submittedBy": imp.get("agentName"),
                "submittedAt": imp.get("submittedAt"),
            }
    return None


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


def cmd_branch_preview_url(args: argparse.Namespace) -> None:
    """打印分支的 v3 预览域名（来自 `/api/branches` 的 previewSlug 字段，
    后端唯一来源 `cds/src/services/preview-slug.ts:computePreviewSlug`）。

    `BRANCH_ID` 是 CDS 内部 canonical id（如 `prd-agent-claude-foo-bar`），
    不是裸 git 分支名。可先调 `branch list` 看。

    退化路径：API 没返回 previewSlug 时（旧版本 CDS / 临时故障）回退到
    `id.host` 形式并打 stderr 警告。
    """
    branch_id = args.id
    body = _call("GET", "/api/branches", timeout=30)
    root = _preview_root_from_host()
    # 2xx 非 JSON 响应（如代理 / WAF 返回 HTML 错误页 200）时 _call 透传 str；
    # 直接 body.get(...) AttributeError。与 cmd_branch_id 对齐守护。
    if not isinstance(body, dict):
        die(f"/api/branches 返回非 JSON 响应（type={type(body).__name__}），"
            f"无法解析 — 检查 CDS proxy 是否健康，或 CDS_HOST 是否正确",
            code=3, extra={"body": body if isinstance(body, str) else repr(body)})
        return
    # `body.get("branches", [])` 在 "branches": null 时返回 None（默认值只在 key
    # 缺失时生效），下面 for 迭代会 TypeError。统一 `or []` 兜底；同时过滤非 dict
    # 元素，防 `[null]` / 混合类型 payload 让 .get() AttributeError 给 traceback。
    for b in [x for x in (body.get("branches") or []) if isinstance(x, dict)]:
        if b.get("id") == branch_id:
            slug = b.get("previewSlug")
            if not slug:
                # canonical id（带 project 前缀）≠ v3 previewSlug，吃下去会输出
                # 错的 host。明确报错而不是静默退化。后端应永远返回 previewSlug。
                die(f"/api/branches 响应缺 previewSlug 字段（分支={branch_id}）。"
                    f"CDS 版本过旧或后端 bug，请升级 CDS 或检查 cds/src/routes/branches.ts",
                    code=3, extra={"branch": b})
                return
            # trailing `/` 与 `preview-url` 顶层命令对齐，避免下游脚本因 URL
            # 形态不一致而需要 sed 归一
            url = f"https://{slug}.{root}/"
            if _HUMAN:
                print(url)
            else:
                ok({"branchId": branch_id, "previewSlug": slug, "url": url})
            return
    die(f"分支不存在: {branch_id}", code=2)


# ──────────────────────────────────────────────────────────────────────────
# 预览 URL 顶层入口（零参数，AI / handoff / smoke 全部走这里）
#
# 设计哲学：所有 skill / 文档 / commit message **不得自己 slugify / 拼 URL**，
# 统一调 `cdscli preview-url`。这是预览 URL 唯一的可执行 SSOT。
#
# 决策顺序（从最准 → 最 fallback）：
#   1. CDS API：有 CDS_HOST + (AI_ACCESS_KEY 或 CDS_PROJECT_KEY) → 查
#      /api/branches 匹配 git 分支，拿后端 `previewSlug` 字段（永远与
#      cds/src/services/preview-slug.ts 对齐）
#   2. 本地 v3 公式：没 CDS context → 用 git 分支名 + 仓库根目录名 slugify 推算
#      （依赖「目录名 slugify 后 == CDS 项目 slug」的隐含约定）
#   3. 失败：未在 git 仓库里 / 没分支 → exit 1
# ──────────────────────────────────────────────────────────────────────────
def _slugify_for_preview(s: str) -> str:
    """与 cds/src/services/preview-slug.ts:slugifyForPreview 完全一致。"""
    s = s.lower()
    s = re.sub(r'[^a-z0-9-]+', '-', s)
    s = re.sub(r'-+', '-', s)
    return s.strip('-')


def _repo_name_from_git_ref(raw: str) -> str:
    """与 cds/src/services/preview-slug.ts:repoNameFromGitRef 保持语义一致。"""
    value = (raw or "").strip()
    if not value:
        return ""
    without_query = re.sub(r'[?#].*$', '', value).rstrip('/')
    path_part = without_query
    if re.match(r'^[^@\s]+@[^:\s]+:.+', without_query):
        path_part = without_query.split(':', 1)[1]
    else:
        parsed = urllib.parse.urlparse(without_query)
        if parsed.scheme and parsed.path:
            path_part = parsed.path
    last = [p for p in path_part.replace('\\', '/').split('/') if p]
    if not last:
        return ""
    return _slugify_for_preview(re.sub(r'\.git$', '', last[-1], flags=re.I))


def _git_origin_slug() -> str:
    try:
        remote = subprocess.check_output(
            ["git", "config", "--get", "remote.origin.url"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return ""
    return _repo_name_from_git_ref(remote)


def _project_slug_hint(repo_root: str) -> str:
    hints = _project_slug_hints(repo_root)
    return hints[0] if hints else ""


def _project_slug_hints(repo_root: str) -> list[str]:
    def unique(values: tuple[str, ...]) -> list[str]:
        seen = set()
        out = []
        for value in values:
            if value and value not in seen:
                seen.add(value)
                out.append(value)
        return out

    explicit = os.environ.get("CDS_PROJECT_SLUG", "").strip()
    if explicit:
        return [_slugify_for_preview(explicit)]
    directory_slug = _slugify_for_preview(os.path.basename(repo_root))
    origin_slug = _git_origin_slug()
    if directory_slug in _GENERIC_WORKSPACE_SLUGS:
        return unique((directory_slug, origin_slug))
    return unique((directory_slug or origin_slug,))


def _compute_preview_slug(branch: str, project_slug: str) -> str:
    """与 cds/src/services/preview-slug.ts:computePreviewSlug 完全一致（v3）。

    本仓库其它任何 Python 脚本都不应再自己实现这套逻辑——import 这里。
    """
    project = _slugify_for_preview(project_slug)
    if not branch:
        return project
    cut_at = branch.find('/')
    if cut_at < 0:
        tail = _slugify_for_preview(branch)
        return f"{tail}-{project}" if tail else project
    prefix = _slugify_for_preview(branch[:cut_at])
    tail = _slugify_for_preview(branch[cut_at + 1:])
    if not prefix:
        return f"{tail}-{project}" if tail else project
    if not tail:
        return f"{prefix}-{project}"
    return f"{tail}-{prefix}-{project}"


def _preview_root_from_host() -> str:
    """从 CDS_HOST 推预览域根（共享给所有 preview-url 相关函数，无 CDS_HOST 时
    回退 `miduo.org`，避免 fallback 写死单一 root）。"""
    host = os.environ.get("CDS_HOST", "").strip().rstrip("/")
    if host.startswith("http://") or host.startswith("https://"):
        host = host.split("://", 1)[1]
    # 拆出 port-less 部分用于后缀匹配（IPv6 bracket-aware；普通 host split `:`）。
    # 注意：port-less 仅用于"是否走 miduo.org 预览根"的判断，**不能**直接当返回值——
    # 非 miduo 部署（如 `localhost:9900`）必须保留 port，否则下游拼出 `slug.localhost/`
    # 而非 `slug.localhost:9900/`，整个 preview URL 走错端口（Codex P2 抓出）。
    if host.startswith("["):
        end = host.find("]")
        host_no_port = host[: end + 1] if end >= 0 else host
    else:
        host_no_port = host.split(":", 1)[0]
    if not host_no_port:
        return "miduo.org"
    # `cds.miduo.org` / 普通 miduo 子域 → 预览根仍走 miduo.org（无 port，由 cds
    # proxy 接管 80/443）；非 miduo 部署返回原始 host 保留 port 信息。
    if host_no_port == "miduo.org" or host_no_port.endswith(".miduo.org"):
        return "miduo.org"
    return host


def _has_cds_auth() -> bool:
    """与 _auth_headers() 的逻辑保持一致：项目级 cdsp_* 或全局 AI_ACCESS_KEY 任一。"""
    return bool(os.environ.get("CDS_PROJECT_KEY", "").strip()
                or os.environ.get("AI_ACCESS_KEY", "").strip())


def _call_safe(method: str, path: str, timeout: int = 10) -> Any:
    """像 _call(quiet=True) 但**网络错误也走 __error__ 包**而不是 _request.die()。

    背景：_request 在 URLError / TimeoutError 时调 die() —— die() 先 print
    一份错误 JSON 到 stdout，再 sys.exit。如果调用方用 `except SystemExit:`
    拦下走 fallback 再 print 成功 JSON，**JSON 模式下会输出两份 payload**，
    机器解析当场崩。

    为了让 preview-url / smoke 这类"网络故障静默退化"的命令真正干净，
    必须从一开始就不让 die() 写 stdout。本函数直接调 urllib，把所有失败
    收口为 `{"__error__": True, "status": N, "body": ...}` 包返回。
    """
    url = _cds_base() + path
    headers = {
        "Accept": "application/json",
        "X-CdsCli-Version": VERSION,
        **_auth_headers(),
    }
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                return raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            parsed = raw
        return {"__error__": True, "status": e.code, "body": parsed}
    except urllib.error.URLError as e:
        return {"__error__": True, "status": 0, "body": f"网络错误: {e.reason}"}
    except TimeoutError:
        return {"__error__": True, "status": 0,
                "body": f"请求超时 (timeout={timeout}s)"}


def _branches_path() -> str:
    """`/api/branches` 路径，自动追加 `?project=<id>`（取 CDS_PROJECT_ID）。

    必要性：多项目 CDS 下同一 git 分支名可能在多个项目里都存在，不带项目过滤
    取首条会拿到错误项目的 canonical id / previewSlug。所有按 git 分支查询的
    入口都要走这条路径。
    """
    project = os.environ.get("CDS_PROJECT_ID", "").strip()
    if project:
        return f"/api/branches?project={urllib.parse.quote(project)}"
    return "/api/branches"


def _match_branches_for_project(branches: list, git_branch: str,
                                project_slug_hints: Any,
                                already_scoped: bool) -> list:
    """从 `/api/branches` 结果里筛选属于当前项目的、且 git branch 字段匹配的条目。

    多项目 CDS 同一 git 分支名可能在不同项目都存在；如果没 CDS_PROJECT_ID
    走 server-side `?project=` 过滤，就要在客户端用本地仓库名 slugify 出来
    的 hint 做二次过滤——canonical id 形式是 `${projectSlug}-${slugify(branch)}`，
    且新版后端会返回 `projectSlug` / `projectId` 字段。

    - already_scoped=True 时（CDS_PROJECT_ID 已传给后端）跳过二次过滤
    - 否则永远按 project hint 校验——**即使只有一条匹配也要过滤**，否则别项目
      的同名分支会被误当成本项目的（用户无该分支但 CDS 上有他人同名）
    """
    # `body.get("branches", [])` 在 `"branches": null` 时返回 None（默认值只在
    # key 缺失时生效），传到这里迭代会 TypeError。在入口统一兜底为空 list。
    # 同时过滤非 dict 元素（API 可能返回 `[null]` / 混合类型 / 字符串等异常 payload），
    # 避免下面 `.get()` AttributeError 把畸形数据问题伪装成 traceback。
    branches = [b for b in (branches or []) if isinstance(b, dict)]
    matches = [b for b in branches if b.get("branch") == git_branch]
    if already_scoped:
        return matches
    # 不论几条都按 project hint 筛——单条来自别项目的同样要过滤掉
    legacy_bare_slug = _slugify_for_preview(git_branch)
    # 探测 CDS 实例是否已多项目化：只要 branches 列表里有**任何** entry
    # 带 projectId / projectSlug 字段，就说明后端是新版多项目格式，此时
    # legacy 兜底（裸 slug id）会跨项目误匹配（Bugbot High：另一项目的
    # legacy entry 会污染本项目结果）—— 必须禁用 legacy 启发式。
    multi_project_cds = any(b.get("projectId") or b.get("projectSlug")
                            for b in branches)
    if isinstance(project_slug_hints, str):
        hints = [project_slug_hints] if project_slug_hints else []
    else:
        hints = [h for h in (project_slug_hints or []) if isinstance(h, str) and h]
    expected_previews = {_compute_preview_slug(git_branch, h) for h in hints}

    def _belongs(b: dict) -> bool:
        if b.get("previewSlug") and b["previewSlug"] in expected_previews:
            return True
        if b.get("projectSlug") and b["projectSlug"] in hints:
            return True
        if b.get("projectId") and b["projectId"] in hints:
            return True
        # canonical id 前缀启发式（兼容老版 API 没 projectSlug 字段）
        bid = b.get("id", "")
        if any(bid.startswith(f"{h}-") for h in hints):
            return True
        # legacy 项目 canonical id 是裸 branch slug（无项目前缀）。仅在
        # **整个 CDS 实例都还是 legacy 单项目格式**时放行——避免多项目
        # CDS 下别人的 legacy entry 被误判成本项目。
        # 后端显式 `b.legacy=true` 也算（新版后端可能加这个字段）。
        if bid == legacy_bare_slug and (b.get("legacy") or not multi_project_cds):
            return True
        return False
    scoped = [b for b in matches if _belongs(b)]
    if matches and not scoped:
        # 仅当后端确实返回了 N 条同名分支但都不属于本项目时才提示。
        # branches 列表本就为空（API 失败被空集替代）时不打这条噪音 warn。
        hint_text = ", ".join(hints) or "<empty>"
        print(f"[warn] /api/branches 有 {len(matches)} 条同名分支但无一匹配项目"
              f" hint '{hint_text}'，可能是目录名 ≠ CDS 项目 slug；"
              f"设 CDS_PROJECT_ID 走 server-side 过滤更稳",
              file=sys.stderr)
    return scoped


def _die_if_ambiguous_project_matches(scoped: list, git_branch: str,
                                      project_slug_hints: list[str]) -> None:
    if len(scoped) <= 1:
        return
    die(f"/api/branches 有 {len(scoped)} 条同名分支 '{git_branch}' "
        f"同时匹配本地项目 hints '{', '.join(project_slug_hints)}'。"
        f"无法安全判断当前 checkout 对应哪个 CDS 项目；请设置 "
        f"CDS_PROJECT_ID=<真实 projectId> 后重试。",
        code=2, extra={
            "matches": scoped,
            "projectHints": project_slug_hints,
        })


def _warn_quiet_call_error(body: Any, label: str) -> bool:
    """如果 `_call(..., quiet=True)` 返回了 __error__ 包，打 stderr 警告并返回 True。
    调用方决定是否继续 / 退化。"""
    if isinstance(body, dict) and body.get("__error__"):
        status = body.get("status")
        msg = body.get("body")
        if isinstance(msg, dict):
            msg = msg.get("message") or msg.get("error") or msg
        print(f"[warn] {label}: HTTP {status} — {msg}", file=sys.stderr)
        return True
    return False


def cmd_preview_url(args: argparse.Namespace) -> None:
    """打印当前分支的 v3 预览 URL（自动检测 git 分支 + 项目，无需参数）。

    所有 skill / 文档 / handoff message **必须**走这条命令，禁止自己 slugify。
    SSOT：cds/src/services/preview-slug.ts:computePreviewSlug（v3）。
    """
    # Step 0: 取 git 分支 + 仓库根
    try:
        branch = subprocess.check_output(
            ["git", "branch", "--show-current"],
            text=True, stderr=subprocess.DEVNULL).strip()
        repo_root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        die("当前目录不在 git 仓库内", code=1)
        return
    if not branch:
        die("当前没有分支（detached HEAD？）— 先 git checkout 一个功能分支", code=1)
        return

    project_slug_hints = _project_slug_hints(repo_root)
    fallback_project_slug = project_slug_hints[0] if project_slug_hints else ""
    root = _preview_root_from_host()

    # Step 1: 优先走 CDS API（有 CDS_HOST + 任一认证密钥时；
    # _auth_headers 同时支持 CDS_PROJECT_KEY 与 AI_ACCESS_KEY，这里两者满足其一即可）
    cds_host_set = bool(os.environ.get("CDS_HOST", "").strip())
    if cds_host_set and _has_cds_auth():
        # 用 _call_safe 而不是 _call(quiet=True)：后者在网络错误时会让
        # _request.die() 往 stdout 写一份错误 JSON，再被 except SystemExit
        # 拦下走 fallback 又输出一份 ok JSON —— JSON 模式下双份 payload
        # 让机器解析崩。_call_safe 把所有失败收口为 __error__ 包，单一路径。
        body = _call_safe("GET", _branches_path(), timeout=10)
        api_failed = _warn_quiet_call_error(body, "调 /api/branches")
        # 2xx 非 JSON 响应（代理 / WAF 返回 HTML 错误页 200 等）时 _call_safe
        # 透传原始 str。不能静默退化到 fallback URL，否则会掩盖 proxy 故障 +
        # 给可能错的 URL。stderr 警告告知用户，再走本地 fallback（与 API 错误
        # 路径一致：用户已被警告，结果仍可用最稳妥的本地推算）。
        if not api_failed and not isinstance(body, dict):
            print(f"[warn] /api/branches 返回非 JSON 响应"
                  f"（type={type(body).__name__}），可能 CDS proxy 异常；"
                  f"回退本地 v3 推算（结果可能与 CDS 实际不符）",
                  file=sys.stderr)
            api_failed = True
        # 项目身份过滤：没 CDS_PROJECT_ID 时多项目 CDS 可能有同名分支，取首条
        # 会拿到错项目的 previewSlug。generic workspace 目录同时接受目录 slug
        # 和 git remote alias；本地 fallback 仍使用目录 slug，避免碰撞时造错 host。
        project_scoped = bool(os.environ.get("CDS_PROJECT_ID", "").strip())
        # `body.get("branches", [])` 在 "branches": null 时返回 None（默认值
        # 只在 key 缺失时生效）；用 `or []` 兜底。
        branches_list = ((body.get("branches") or [])
                         if isinstance(body, dict) and not api_failed else [])
        scoped = _match_branches_for_project(
            branches_list, branch, project_slug_hints, project_scoped)
        if not project_scoped:
            _die_if_ambiguous_project_matches(scoped, branch, project_slug_hints)
        # 区分两种 scoped 为空的情况，避免静默给错 URL：
        #   1. raw 本就无该 git 分支 → fallback 合理（用户没部署过）
        #   2. raw 里**有**但本地项目 hint 过滤排除掉 → 错配，必须 die 否则
        #      用户拿到的 fallback URL 与后端 previewSlug 不一致（Bugbot Medium）
        if not scoped and not project_scoped:
            raw_same_branch = [b for b in branches_list
                               if b.get("branch") == branch]
            if raw_same_branch:
                die(f"/api/branches 有 {len(raw_same_branch)} 条同名分支 "
                    f"'{branch}' 但都不属于本地项目 hint "
                    f"'{', '.join(project_slug_hints)}'。可能是仓库目录名 ≠ CDS 项目 "
                    f"slug — 设 CDS_PROJECT_ID=<真实 projectId> 重试，"
                    f"或检查 /api/projects 列表。",
                    code=2, extra={
                        "rawMatches": raw_same_branch,
                        "projectHints": project_slug_hints,
                    })
                return
        for b in scoped:
            slug = b.get("previewSlug")
            if slug:
                url = f"https://{slug}.{root}/"
                if _HUMAN:
                    print(url)
                else:
                    ok({"source": "cds-api", "branch": branch,
                        "branchId": b.get("id"),
                        "previewSlug": slug, "url": url})
                return
            # 匹配到本项目分支但缺 previewSlug 字段 — 与 `branch preview-url`
            # 行为一致：服务端返回不完整，明确 die 而不是静默退化到 fallback
            # （fallback URL 与 CDS 实际不一致，会让用户访问到错的 host）。
            die(f"/api/branches 匹配到分支 '{branch}'（id={b.get('id')}）"
                f"但缺 previewSlug 字段。CDS 版本过旧或后端 bug，请升级 CDS "
                f"或检查 cds/src/routes/branches.ts",
                code=3, extra={"branch": b})
            return
        # 走到这里说明 CDS 没这条分支，落到 fallback（api_failed 时上面 warn 过了，
        # 不再打 "没找到分支" 的 info 避免双重消息）
        if not api_failed:
            print(f"[info] /api/branches 没找到 git 分支 '{branch}'，回退本地 v3 推算",
                  file=sys.stderr)
    elif cds_host_set:
        # CDS_HOST 设了但没 auth — 给用户明确提示，否则会困惑"为啥不走 API"
        print(f"[warn] CDS_HOST 已设但缺 AI_ACCESS_KEY / CDS_PROJECT_KEY，"
              f"跳过 API 走本地 v3 推算（可能与后端 previewSlug 不一致）",
              file=sys.stderr)

    # Step 2: 本地 v3 公式（fallback）— root 仍走 _preview_root_from_host 不写死 miduo.org
    slug = _compute_preview_slug(branch, fallback_project_slug)
    url = f"https://{slug}.{root}/"
    if _HUMAN:
        print(url)
    else:
        ok({
            "source": "local-v3-fallback",
            "branch": branch,
            "projectSlug": fallback_project_slug,
            "previewSlug": slug,
            "url": url,
            "note": "本地推算使用当前目录名或 CDS_PROJECT_SLUG。generic workspace "
                    "目录下设置 CDS_HOST + (AI_ACCESS_KEY 或 CDS_PROJECT_KEY) "
                    "走 API 模式才能使用服务端 collision-checked alias。",
        })


def cmd_branch_id(args: argparse.Namespace) -> None:
    """打印当前 git 分支对应的 CDS canonical branch id（零参数）。

    多项目 CDS 下，canonical id = `${projectSlug}-${slugify(branch)}`，
    不是裸 `tr '/' '-'`。所有需要往 `/api/branches/:id` 发请求的 skill
    （bridge / agent-guide / 任何 cdscli 子命令）都应通过这条命令拿 id，
    禁止手算。

    依赖：CDS_HOST + (AI_ACCESS_KEY 或 CDS_PROJECT_KEY)，否则 exit 1。
    """
    try:
        branch = subprocess.check_output(
            ["git", "branch", "--show-current"],
            text=True, stderr=subprocess.DEVNULL).strip()
        repo_root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        die("当前目录不在 git 仓库内", code=1)
        return
    if not branch:
        die("当前没有分支（detached HEAD？）", code=1)
        return
    project_slug_hints = _project_slug_hints(repo_root)

    # 用 _call_safe 而不是 _call(quiet=True)：后者在 URLError / TimeoutError 时
    # _request.die() exit 1（违反 CLI 契约 4xx→2/5xx→3）。_call_safe 把 HTTP +
    # 网络错误统一收口为 __error__ 包（网络错误 status=0），下面按 status 路由 exit。
    body = _call_safe("GET", _branches_path(), timeout=10)
    # API 失败（401 / 5xx / 网络）必须明确暴露，不能被后面 "找不到分支" 兜底 die 遮蔽。
    # exit code 契约：4xx → 2（用户/认证错误），5xx + 网络错误 → 3（retriable）。
    if isinstance(body, dict) and body.get("__error__"):
        status = body.get("status")
        msg = body.get("body")
        if isinstance(msg, dict):
            msg = msg.get("message") or msg.get("error") or msg
        try:
            status_int = int(status) if status is not None else 0
        except (TypeError, ValueError):
            status_int = 0
        # 4xx → 2；其它（5xx / 0 网络错误 / 超时）→ 3（retriable）
        exit_code = 2 if 400 <= status_int < 500 else 3
        die(f"调 /api/branches 失败 HTTP {status}: {msg}（检查 CDS_HOST / 认证密钥）",
            code=exit_code, extra={"status": status, "body": body.get("body")})
        return
    # _call(quiet=True) 在 2xx 但响应非 JSON 时透传原始 str（如代理返回 HTML
    # 错误页 200）。直接 body.get(...) 会 AttributeError，给用户 traceback
    # 而不是结构化错误。
    if not isinstance(body, dict):
        die(f"/api/branches 返回非 JSON 响应（type={type(body).__name__}），"
            f"无法解析 — 检查 CDS proxy 是否健康，或 CDS_HOST 是否正确",
            code=3, extra={"body": body if isinstance(body, str) else repr(body)})
        return
    project_scoped = bool(os.environ.get("CDS_PROJECT_ID", "").strip())
    branches_list = body.get("branches") or []
    matches = _match_branches_for_project(
        branches_list, branch, project_slug_hints, project_scoped)
    if not project_scoped:
        _die_if_ambiguous_project_matches(matches, branch, project_slug_hints)
    for b in matches:
        bid = b.get("id")
        if bid:
            if _HUMAN:
                print(bid)
            else:
                ok({"branch": branch, "branchId": bid})
            return
    # 与 cmd_preview_url 行为对齐：raw 里**有**同名分支但本地 hint 排除掉，
    # 不能误导用户去 "先 /cds-deploy"——99% 是 repo 目录名 ≠ CDS 项目 slug，
    # 应该明确报错 + 提示设 CDS_PROJECT_ID（Bugbot Medium 抓出 cmd_branch_id
    # 漏了这个分支，会卡 bridge / tagging 流程）
    if not project_scoped:
        raw_same_branch = [b for b in branches_list if b.get("branch") == branch]
        if raw_same_branch:
            die(f"/api/branches 有 {len(raw_same_branch)} 条同名分支 '{branch}' "
                f"但都不属于本地项目 hint '{', '.join(project_slug_hints)}'。可能是仓库目录"
                f"名 ≠ CDS 项目 slug — 设 CDS_PROJECT_ID=<真实 projectId> 重试，"
                f"或检查 /api/projects 列表。",
                code=2, extra={
                    "rawMatches": raw_same_branch,
                    "projectHints": project_slug_hints,
                })
            return
    die(f"CDS 里找不到 git 分支 '{branch}'，先跑 /cds-deploy 部署", code=2)


def cmd_branch_create(args: argparse.Namespace) -> None:
    """显式创建分支。POST /api/branches 用 `projectId` 字段(后端约定);
    CLI 暴露 --project flag 抹平这个 friction(F7)。

    body 还有 `branch` 字段。后端会读 project.repoPath + 这个 branch 名做
    git worktree,并基于 cds-compose 自动创建 build profiles + service 占位。
    """
    project = (args.project
               or os.environ.get("CDS_PROJECT_ID", "")).strip()
    if not project:
        die("--project 或 CDS_PROJECT_ID 必填", code=1)
    branch = (args.branch or "").strip()
    if not branch:
        die("--branch 必填", code=1)
    body = _call("POST", "/api/branches",
                 body={"projectId": project, "branch": branch},
                 timeout=60)
    if _HUMAN:
        bid = body.get("id") if isinstance(body, dict) else "?"
        status = body.get("status") if isinstance(body, dict) else "?"
        print(f"[OK] 已创建分支 {branch} id={bid} status={status}")
        return
    ok(body, note=f"已创建分支 {branch} (project={project})")


def cmd_preflight(args: argparse.Namespace) -> None:
    """检查 CDS 服务端和本地凭据的全套前置条件，避免 onboard 产生半成品项目。

    检查项：
      - CDS_HOST 有效（能连通 /healthz）
      - AI_ACCESS_KEY / CDS_PROJECT_KEY 认证可用（/api/config 通过）
      - reposBase 已配置（独立仓库 clone 依赖）
      - pending-import API 可访问（compose 提交依赖）
    """
    checks: list[dict[str, Any]] = []

    def _check(name: str, ok_val: bool, detail: str, fix: str = "") -> None:
        checks.append({
            "name": name,
            "pass": ok_val,
            "detail": detail,
            **({"fix": fix} if fix else {}),
        })

    # 1. CDS_HOST 连通性
    host_set = bool(os.environ.get("CDS_HOST", "").strip())
    _check("CDS_HOST 已设置", host_set,
           f"CDS_HOST={os.environ.get('CDS_HOST', '(未设置)')}",
           fix="export CDS_HOST=<your-cds-host>")
    if host_set:
        status, _, _ = _request("GET", "/healthz", timeout=8)
        _check("CDS /healthz 可达", 200 <= status < 400,
               f"HTTP {status}",
               fix="检查 CDS 服务是否运行，以及 CDS_HOST 是否正确")

    # 2. 认证凭据
    has_key = bool(os.environ.get("AI_ACCESS_KEY", "").strip()
                   or os.environ.get("CDS_PROJECT_KEY", "").strip())
    _check("认证凭据已设置", has_key,
           "AI_ACCESS_KEY 或 CDS_PROJECT_KEY 至少一个非空",
           fix="export AI_ACCESS_KEY=<key>")

    # 3. /api/config — reposBase
    repos_base_ok = False
    repos_base_val = None
    if host_set and has_key:
        status, cfg, _ = _request("GET", "/api/config", timeout=10)
        if 200 <= status < 300 and isinstance(cfg, dict):
            repos_base_val = cfg.get("reposBase")
            repos_base_ok = bool(repos_base_val)
            _check("/api/config 可访问", True, f"reposBase={repos_base_val!r}")
            _check("reposBase 已配置", repos_base_ok,
                   f"当前 reposBase={repos_base_val!r}",
                   fix="在 CDS 服务端设置环境变量 CDS_REPOS_BASE=<path>，如 /root/cds/.cds-repos，然后重启 CDS")
        else:
            _check("/api/config 可访问", False, f"HTTP {status}",
                   fix="检查认证凭据和 CDS 服务状态")

    passed = sum(1 for c in checks if c["pass"])
    total = len(checks)
    failed = [c for c in checks if not c["pass"]]
    result = {
        "passed": f"{passed}/{total}",
        "checks": checks,
        "ready": passed == total,
    }
    if failed:
        result["blockers"] = [
            {"name": c["name"], "fix": c.get("fix", "")} for c in failed
        ]
        die(f"preflight 未通过 ({passed}/{total})，{len(failed)} 项阻塞",
            code=2, extra={"data": result})
    ok(result, note=f"preflight 全部通过 ({passed}/{total})，可以执行 onboard")


def cmd_import(args: argparse.Namespace) -> None:
    """将本地已有的 compose 文件（不重新扫描）提交到 CDS pending-import。

    适用场景：scan 生成的 compose 已手工修改，需要直接提交而不触发重新扫描。
    """
    compose_file = os.path.abspath(args.compose)
    if not os.path.exists(compose_file):
        die(f"compose 文件不存在: {compose_file}", code=1)
    pid = args.project
    try:
        with open(compose_file, "r", encoding="utf-8") as f:
            yaml_content = f.read()
    except Exception as e:
        die(f"读取 {compose_file} 失败: {e}", code=1)
    if _HUMAN:
        print(f"[import] 提交 {os.path.basename(compose_file)} ({len(yaml_content)} bytes) → project {pid}")
    status, body, _ = _request(
        "POST", f"/api/projects/{urllib.parse.quote(pid)}/pending-import",
        body={"agentName": "cdscli", "purpose": "cdscli import",
              "composeYaml": yaml_content}, timeout=30,
    )
    if status >= 400:
        die(f"提交失败 HTTP {status}: {body}", code=2 if status < 500 else 3)
    import_id = body.get("importId") if isinstance(body, dict) else None
    approve_url = f"{_cds_base()}/project-list?pendingImport={import_id}"
    next_cmds = [
        f"cdscli project clone {pid}",
        f"cdscli branch create --project {pid} --branch main",
        f"cdscli branch deploy <branchId> --timeout 300",
        f"cdscli smoke <branchId>",
    ]
    # CDS-CLI-008/009: 结构化 nextActions —— Agent 可机读，按顺序执行
    next_actions = [
        {"step": "approve", "url": approve_url,
         "description": "用户在 dashboard 批准本次 import"},
        {"step": "wait", "command": f"cdscli import-wait {import_id}",
         "description": "等待 import 进入 approved/applied 状态"},
        {"step": "clone", "command": f"cdscli project clone {pid}",
         "description": "拉取项目 git 仓库到 CDS（如尚未 clone）"},
        {"step": "create-branch",
         "command": f"cdscli branch create --project {pid} --branch <name>",
         "description": "为目标分支创建 worktree + build profile"},
        {"step": "deploy", "command": "cdscli branch deploy <branchId>",
         "description": "触发部署"},
    ]
    ok({
        "importId": import_id,
        "approveUrl": approve_url,
        "composeFile": os.path.basename(compose_file),
        "yamlLen": len(yaml_content),
        "stage": "submitted",
        "nextSteps": "用户批准后依次执行：" + " && ".join(next_cmds),
        "nextActions": next_actions,
    }, note=f"已提交待批 (importId={import_id})，去 {approve_url} 批准；批准后执行 project clone")


# ── pending-import 状态查询（issue #553）─────────────────────────────

def _fetch_pending_import(import_id: str) -> dict[str, Any] | None:
    """查 GET /api/pending-imports/:id；用 _request 走标准错误路径。

    返回 None = 未找到 / 端点不存在；返回 dict = 完整 record。
    """
    s, body, _ = _request("GET",
                          f"/api/pending-imports/{urllib.parse.quote(import_id)}",
                          timeout=10)
    if s == 404:
        return None
    if not (200 <= s < 300):
        die(f"查询 import 失败 HTTP {s}: {body}",
            code=2 if s < 500 else 3)
    if isinstance(body, dict):
        # 端点返回 {import: {...}}，向下兼容直接返回 record
        return body.get("import") if "import" in body else body
    return None


def cmd_import_status(args: argparse.Namespace) -> None:
    """查询单个 pending-import 当前状态。

    输出: {ok, data: {importId, status, projectId, submittedAt, decidedAt?, ...}}
    status 枚举: pending / approved / rejected / applied / failed
    """
    import_id = (getattr(args, "id", None) or "").strip()
    if not import_id:
        die("import id 必填: cdscli import-status <importId>", code=1)
    rec = _fetch_pending_import(import_id)
    if rec is None:
        die(f"未找到 importId={import_id}（可能已过期或被清理）",
            code=2, extra={"data": {"importId": import_id, "status": "not_found"}})
    # 控制返回大小：raw YAML 通常很大，默认裁掉
    rec_compact = {k: v for k, v in rec.items()
                   if k not in ("composeYaml", "compose_yaml")}
    rec_compact["yamlLen"] = len(rec.get("composeYaml") or rec.get("compose_yaml") or "")
    ok(rec_compact, note=f"importId={import_id} status={rec.get('status', '?')}")


def cmd_import_wait(args: argparse.Namespace) -> None:
    """阻塞等待 import 进入终态（approved / rejected / applied / failed）。

    --timeout 默认 600s。每 3s 轮询一次。
    """
    import_id = (getattr(args, "id", None) or "").strip()
    if not import_id:
        die("import id 必填: cdscli import-wait <importId>", code=1)
    timeout = int(getattr(args, "timeout", 600) or 600)
    interval = int(getattr(args, "interval", 3) or 3)
    deadline = time.time() + timeout
    started_at = time.time()
    last_status: str | None = None
    poll_count = 0
    success_terminal = {"approved", "applied"}
    failure_terminal = {"rejected", "failed"}
    while time.time() < deadline:
        poll_count += 1
        rec = _fetch_pending_import(import_id)
        if rec is None:
            die(f"未找到 importId={import_id}", code=2,
                extra={"data": {"importId": import_id, "status": "not_found",
                                "polls": poll_count}})
        last_status = rec.get("status")
        if last_status in success_terminal:
            ok({
                "importId": import_id,
                "status": last_status,
                "projectId": rec.get("projectId"),
                "decidedAt": rec.get("decidedAt"),
                "decisionReason": rec.get("decisionReason"),
                "elapsed": int(time.time() - started_at),
                "polls": poll_count,
            }, note=f"import 已收敛: status={last_status}")
            return  # ok() 内部会 sys.exit(0),此处兜底防 SystemExit 被外层捕获后继续轮询
        if last_status in failure_terminal:
            die(f"import 已被拒绝/失败: status={last_status}", code=2,
                extra={"data": {
                    "importId": import_id,
                    "status": last_status,
                    "projectId": rec.get("projectId"),
                    "decidedAt": rec.get("decidedAt"),
                    "decisionReason": rec.get("decisionReason"),
                    "elapsed": int(time.time() - started_at),
                    "polls": poll_count,
                }})
            return  # die() 内部 sys.exit,同上兜底
        time.sleep(interval)
    die(f"等待 import 超时（{timeout}s），最近状态: {last_status}",
        code=2, extra={"data": {
            "importId": import_id,
            "status": last_status,
            "elapsed": int(time.time() - started_at),
            "polls": poll_count,
            "timeout": timeout,
        }})


def cmd_project_imports(args: argparse.Namespace) -> None:
    """列出某个项目下所有/最近的 pending-import 记录。

    服务端 GET /api/pending-imports 返回**全部** imports；这里按 projectId 过滤。
    --status 可选: pending(默认) / all / approved / rejected / applied / failed
    """
    pid = (getattr(args, "project", None) or "").strip()
    if not pid:
        die("--project 必填", code=1)
    status_filter = (getattr(args, "status", None) or "pending").strip()
    s, body, _ = _request("GET", "/api/pending-imports", timeout=10)
    if not (200 <= s < 300) or not isinstance(body, dict):
        die(f"查询 pending-imports 失败 HTTP {s}: {body}",
            code=2 if s < 500 else 3)
    imports = body.get("imports") or []
    filtered = []
    for imp in imports:
        if not isinstance(imp, dict):
            continue
        if imp.get("projectId") != pid:
            continue
        if status_filter != "all" and imp.get("status") != status_filter:
            continue
        filtered.append({
            "importId": imp.get("id"),
            "status": imp.get("status"),
            "agentName": imp.get("agentName"),
            "purpose": imp.get("purpose"),
            "submittedAt": imp.get("submittedAt"),
            "decidedAt": imp.get("decidedAt"),
        })
    ok({
        "projectId": pid,
        "filter": status_filter,
        "total": len(filtered),
        "imports": filtered,
    }, note=f"project={pid} {status_filter}={len(filtered)}")


def cmd_onboard(args: argparse.Namespace) -> None:
    """一键 onboarding:create + clone + 等 envMeta 出来 + 提示 required keys。

    主要用于把 friction F3+F7 收敛到一条命令。失败任意一步都立刻 die。
    URL 必填;name / slug / description 走 sensible defaults(slug 从 URL
    推断,name = slug 大写化的伪人话)。
    """
    git_url = (args.git_url or "").strip()
    if not git_url:
        die("git-url 必填", code=1)
    # slugify URL → 取最后一段去 .git
    seg = git_url.rstrip("/").split("/")[-1]
    if seg.endswith(".git"):
        seg = seg[:-4]
    auto_slug = "".join(c if (c.isalnum() or c == "-") else "-"
                        for c in seg.lower())
    auto_slug = auto_slug.strip("-") or "project"
    slug = (args.slug or auto_slug).strip()
    name = (args.name or seg or slug).strip()

    # Step 0: preflight — 检查 reposBase，避免创建半成品项目
    if _HUMAN:
        print(f"[0/3] 检查 CDS 服务端配置（preflight）")
    cfg = _call("GET", "/api/config", timeout=10, quiet=True)
    if isinstance(cfg, dict) and not cfg.get("__error__"):
        repos_base = cfg.get("reposBase")
        if not repos_base:  # 同时捕获 None 和空字符串，与 cmd_preflight 保持一致
            die(
                "preflight 失败：CDS 服务端未配置 CDS_REPOS_BASE，独立仓库项目无法 clone/deploy。\n"
                "用户需要做：在 CDS 服务端环境变量中设置 CDS_REPOS_BASE（如 /root/cds/.cds-repos）并重启 CDS。\n"
                "Agent 可在用户修复后重跑本命令。未创建任何项目，无需清理。",
                code=2,
            )
    elif _HUMAN:
        print(f"  [warn] 无法获取 /api/config，跳过 preflight（将继续尝试创建）")

    # Step 1: create
    if _HUMAN:
        print(f"[1/3] 创建项目 {slug} (name={name})")
    payload: dict[str, Any] = {"name": name, "slug": slug,
                               "gitRepoUrl": git_url}
    if args.description:
        payload["description"] = args.description.strip()
    create_body = _call("POST", "/api/projects",
                        body=payload, timeout=30)
    proj = create_body.get("project") if isinstance(create_body, dict) else None
    pid = (proj or {}).get("id")
    if not pid:
        die(f"创建项目返回缺 id: {create_body}", code=2)

    # Step 2: clone (复用 cmd_project_clone 的流式解析)
    if _HUMAN:
        print(f"[2/3] git clone 项目 (id={pid})")
    clone_args = argparse.Namespace(id=pid)
    # 不能直接调 cmd_project_clone,它会 ok()/sys.exit。inline 重做轻量版:
    url = _cds_base() + f"/api/projects/{urllib.parse.quote(pid)}/clone"
    headers = {"Accept": "text/event-stream", **_auth_headers()}
    req = urllib.request.Request(url, method="POST",
                                 data=b"", headers=headers)
    clone_events: list[dict[str, Any]] = []
    env_meta_seen: dict[str, Any] | None = None
    final_event: str | None = None
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            cur_event: str | None = None
            for line_bytes in resp:
                line = line_bytes.decode("utf-8", errors="replace").rstrip()
                if not line:
                    continue
                if line.startswith("event: "):
                    cur_event = line[7:].strip() or None
                    continue
                if line.startswith("data: "):
                    raw = line[6:]
                    try:
                        parsed = json.loads(raw)
                    except (json.JSONDecodeError, ValueError):
                        parsed = {"raw": raw}
                    if cur_event:
                        parsed["_event"] = cur_event
                    clone_events.append(parsed)
                    if cur_event == "env-meta" or "envMeta" in parsed:
                        env_meta_seen = parsed
                    if _HUMAN:
                        msg = (parsed.get("message")
                               or parsed.get("phase")
                               or parsed.get("step") or "")
                        print(f"  [{cur_event or 'data'}] {msg}".rstrip())
                    if cur_event in ("done", "error", "complete", "fail"):
                        final_event = cur_event
                        break
    except urllib.error.HTTPError as e:
        die(f"clone HTTP {e.code}: "
            f"{e.read().decode('utf-8','replace')[:200]}", code=2)
    except (urllib.error.URLError, TimeoutError):
        # 流闭/超时:已经 done 的话视作成功;否则保留 "stream-closed" 等下面 die
        # Codex review fix(PR #522)— 之前 final_event = final_event or "stream-closed",
        # 然后只在 ("error","fail") 时 die,导致 网络中断/timeout 在 done 之前发生时
        # cdscli onboard 会把"部分克隆 / 失败"当成成功 exit 0。修法:把 stream-closed
        # 也加入 die 列表,只有真正收到 done/complete 才算 success。
        final_event = final_event or "stream-closed"

    if final_event not in ("done", "complete"):
        die(f"clone 未正常完成: final_event={final_event!r} "
            f"(期望 done/complete);事件总数 {len(clone_events)}",
            code=2)

    # Step 3: 拉 required keys 提示用户填(走 GET /api/projects/:id 看 envMeta)
    if _HUMAN:
        print(f"[3/3] 检查 required env keys")
    detail = _call("GET", f"/api/projects/{urllib.parse.quote(pid)}",
                   timeout=15, quiet=True)
    required: list[str] = []
    if isinstance(detail, dict) and not detail.get("__error__"):
        em = (detail.get("envMeta") or detail.get("env_meta") or {})
        if isinstance(em, dict):
            for k, v in em.items():
                if isinstance(v, dict) and v.get("kind") == "required":
                    required.append(k)
    # fallback:从 clone events 里挑出 required(env_meta_seen)
    if not required and isinstance(env_meta_seen, dict):
        em2 = env_meta_seen.get("envMeta") or env_meta_seen.get("data") or {}
        if isinstance(em2, dict):
            for k, v in em2.items():
                if isinstance(v, dict) and v.get("kind") == "required":
                    required.append(k)

    if _HUMAN:
        if required:
            print(f"  需要用户填的 required env: {', '.join(required)}")
            print(f"  下一步: cdscli env set <KEY>=<VALUE> --scope {pid}")
        else:
            print("  没有 required env (或后端尚未生成 envMeta)")

    ok({"projectId": pid, "slug": slug, "name": name,
        "cloneEvents": len(clone_events),
        "finalEvent": final_event,
        "requiredEnvKeys": required},
       note=f"onboarding 完成 (project={pid}, required={len(required)})")


def cmd_env_get(args: argparse.Namespace) -> None:
    scope = args.scope or "_global"
    path = f"/api/env?scope={urllib.parse.quote(scope)}"
    body = _call("GET", path)
    ok(body)


def cmd_env_set(args: argparse.Namespace) -> None:
    """支持两种调用形式(向后兼容):
      cdscli env set KEY=VALUE [--scope ...]      # 经典 form
      cdscli env set --key KEY --value VALUE [--scope ...]
    第二种适合 value 含 `=` 时(JSON / URL / base64)避免歧义。
    """
    k: str | None = None
    v: str | None = None
    if getattr(args, "key", None):
        k = args.key
        v = args.value if args.value is not None else ""
    elif getattr(args, "kv", None):
        if "=" not in args.kv:
            die("格式应为 KEY=VALUE,或改用 --key/--value", code=1)
        k, v = args.kv.split("=", 1)
    else:
        die("必须提供 KEY=VALUE 位置参数 或 --key/--value 组合", code=1)
    scope = args.scope or "_global"
    body = _call("PUT",
                 f"/api/env/{urllib.parse.quote(k)}?scope={urllib.parse.quote(scope)}",
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
            # Use the lightweight probe for post-restart readiness. The full
            # /healthz intentionally checks Docker and can exceed 5s while CDS
            # is building containers, which makes self-update report a false
            # outage even when the control plane is already serving traffic.
            status, _b, _h = _request("GET", "/healthz?lightweight=1", timeout=10)
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


# ── NEW: init wizard, scan, smoke, help-me-check, deploy ──────────


def cmd_init(args: argparse.Namespace) -> None:
    """交互式 env 向导。写入 ~/.cdsrc 与 项目本地 .cds.env。"""
    import subprocess
    print("=== CDS 初始化向导 ===\n", file=sys.stderr)
    cdsrc = os.path.expanduser("~/.cdsrc")
    local_env = os.path.join(os.getcwd(), ".cds.env")

    # Step 1 CDS_HOST
    current = os.environ.get("CDS_HOST", "")
    print(f"Step 1/3: CDS 地址 (当前: {current or '未设置'})", file=sys.stderr)
    host_in = (input("  输入 CDS 地址（如 cds.miduo.org）: ").strip()
               if not args.yes else current)
    host = host_in.replace("https://", "").replace("http://", "").rstrip("/") or current
    if not host:
        die("CDS_HOST 不能为空", code=1)
    os.environ["CDS_HOST"] = host
    print(f"  [OK] CDS_HOST={host}\n", file=sys.stderr)

    # Step 2 auth method
    print("Step 2/3: 认证方式", file=sys.stderr)
    print("  (A) 静态 AI_ACCESS_KEY（最常用）", file=sys.stderr)
    print("  (B) 动态配对（Dashboard 批准）", file=sys.stderr)
    print("  (C) 项目级 cdsp_* 通行证（从项目页复制）", file=sys.stderr)
    choice = (input("  选择 [A/B/C] (默认 A): ").strip().upper() or "A"
              if not args.yes else "A")
    key_line = ""
    if choice == "A":
        existing = os.environ.get("AI_ACCESS_KEY", "")
        if not existing:
            val = input("  粘贴 AI_ACCESS_KEY: ").strip()
            if not val:
                die("AI_ACCESS_KEY 不能为空", code=1)
            os.environ["AI_ACCESS_KEY"] = val
            key_line = f'export AI_ACCESS_KEY="{val}"'
        else:
            print(f"  [OK] 已读到环境里的 AI_ACCESS_KEY (长度 {len(existing)})", file=sys.stderr)
    elif choice == "B":
        # 触发配对请求
        status, body, _ = _request("POST", "/api/ai/request-access",
                                   body={"agentName": "Claude Code",
                                         "purpose": "cdscli init"}, timeout=10)
        if status != 200 and status != 201:
            die(f"配对请求失败 HTTP {status}", code=2)
        req_id = body.get("requestId") if isinstance(body, dict) else None
        print(f"  ⏳ 请去 https://{host}/ Dashboard 右上角批准 AI 配对 (requestId={req_id})",
              file=sys.stderr)
        print("  等待最多 5 分钟…", file=sys.stderr)
        token = None
        for _ in range(60):
            time.sleep(5)
            s2, b2, _ = _request("GET", f"/api/ai/request-status/{req_id}", timeout=5)
            if isinstance(b2, dict) and b2.get("status") == "approved":
                token = b2.get("token")
                break
        if not token:
            die("配对超时", code=2)
        os.environ["AI_ACCESS_KEY"] = token
        key_line = f'# 动态配对 Token（24h 有效）\nexport AI_ACCESS_KEY="{token}"'
    elif choice == "C":
        val = input("  粘贴 cdsp_<slug>_<suffix>: ").strip()
        if not val.startswith("cdsp_"):
            die("格式错误，应以 cdsp_ 开头", code=1)
        os.environ["CDS_PROJECT_KEY"] = val
        key_line = f'export CDS_PROJECT_KEY="{val}"'
    else:
        die(f"未知选择: {choice}", code=1)

    # 跑 auth check 确认
    status, _b, _ = _request("GET", "/api/config", timeout=5)
    if status != 200:
        die(f"认证失败: HTTP {status}（凭据无效或 CDS_HOST 错）", code=2)
    print("  [OK] 认证通过\n", file=sys.stderr)

    # Step 3 projectId
    print("Step 3/3: 首个目标项目（可选）", file=sys.stderr)
    status, projs, _ = _request("GET", "/api/projects", timeout=10)
    plist = projs.get("projects", []) if isinstance(projs, dict) else []
    print("  可用项目: " + ", ".join(p.get("id", "?") for p in plist), file=sys.stderr)
    pid = (input("  输入 projectId (回车跳过): ").strip()
           if not args.yes else "")

    # 写入 ~/.cdsrc
    lines = [
        "# cdscli init 生成，由向导维护，请勿手动编辑该 HOST/KEY 区块",
        f'export CDS_HOST="{host}"',
    ]
    if key_line:
        lines.append(key_line)
    if pid:
        lines.append(f'export CDS_PROJECT_ID="{pid}"')
        os.environ["CDS_PROJECT_ID"] = pid
    content = "\n".join(lines) + "\n"
    with open(cdsrc, "w") as f:
        f.write(content)
    os.chmod(cdsrc, 0o600)
    print(f"  [OK] 已写入 {cdsrc}", file=sys.stderr)
    print(f'\n下一步: source {cdsrc} 然后 cdscli auth check', file=sys.stderr)
    ok({"host": host, "authMethod": choice, "projectId": pid or None,
        "cdsrcPath": cdsrc}, note="init 完成")


def cmd_scan(args: argparse.Namespace) -> None:
    """扫描本地项目结构，输出 cds-compose YAML。

    优先级（2026-04-30 重构，避免之前"骨架级 80% 要手改"的反模式）：
      1. 根目录已有 cds-compose.yml → 直接返回，这是 SSOT
      2. 否则识别 docker-compose.*.yml 的 services（基础设施 + 应用），
         按 image 关键词分类 infra（mongo/redis/postgres/mysql/nginx/...）
         vs app（含 build 的服务），生成完整 yaml
      3. 都没有 → monorepo 扫描，子目录有 manifest 的各起 service

    --apply-to-cds 直接 POST 到 CDS。
    """
    root = os.path.abspath(args.path or ".")
    if not os.path.isdir(root):
        die(f"目录不存在: {root}", code=1)

    signals: dict[str, Any] = {"root": root}

    # 优先级 1: 根目录已有 cds-compose.yml 就直接返回（SSOT）
    # --force-rescan 跳过此步
    force_rescan = getattr(args, "force_rescan", False)
    cds_compose_path = os.path.join(root, "cds-compose.yml")
    if os.path.exists(cds_compose_path) and not force_rescan:
        try:
            with open(cds_compose_path, "r", encoding="utf-8") as f:
                yaml_content = f.read()
            signals["source"] = "cds-compose.yml"
            signals["bytes"] = len(yaml_content)
            _emit_scan_result(args, yaml_content, signals,
                              note="读取仓库根 cds-compose.yml（SSOT）")
            return
        except Exception as e:
            # 读不出来落到优先级 2
            signals["cdsComposeReadError"] = str(e)

    # 优先级 2: 解析 docker-compose.*.yml
    compose_candidates = sorted([f for f in os.listdir(root)
                                 if f.startswith("docker-compose") and f.endswith((".yml", ".yaml"))])
    signals["composeFiles"] = compose_candidates

    if compose_candidates:
        # 选最具代表性的:dev > local > 无后缀(prod-ish) > prod
        # name 形态:docker-compose.yml / docker-compose.dev.yml / docker-compose.local.yaml
        # stem 提取:去 .yml/.yaml 后缀 → 去 docker-compose 前缀 → 剩下中段就是 stem('' / 'dev' / 'local' / ...)
        priority = {"dev": 0, "local": 1, "": 2, "prod": 3}
        def rank(name: str) -> int:
            stem = name
            for ext in (".yaml", ".yml"):
                if stem.endswith(ext):
                    stem = stem[: -len(ext)]
                    break
            stem = stem.replace("docker-compose", "", 1).lstrip(".")
            return priority.get(stem, 99)
        compose_candidates.sort(key=rank)
        chosen = compose_candidates[0]
        signals["composeChosen"] = chosen
        try:
            services = _parse_compose_services(os.path.join(root, chosen))
            if services:
                # Phase 4:_yaml_from_compose_services 现在返回 (yaml, extras),
                # extras 含 orms / schemafulInfra 等给 signals 用
                yaml_content, extras = _yaml_from_compose_services(root, services)
                signals["source"] = f"docker-compose ({chosen})"
                signals["servicesCount"] = len(services)
                if extras.get("orms"):
                    signals["orms"] = extras["orms"]
                if extras.get("schemafulInfra"):
                    signals["schemafulInfra"] = extras["schemafulInfra"]
                if extras.get("deployModes"):
                    signals["deployModes"] = extras["deployModes"]
                # ORM 注入摘要(给用户一眼看到 migration 已自动注入)
                orm_summary = ""
                if extras.get("orms"):
                    pairs = ", ".join(f"{svc}={orm}" for svc, orm in extras["orms"].items())
                    orm_summary = f";已注入 ORM migration: {pairs}"
                _emit_scan_result(args, yaml_content, signals,
                                  note=f"从 {chosen} 解析出 {len(services)} 个服务{orm_summary}")
                return
        except Exception as e:
            signals["composeParseError"] = str(e)

    # 优先级 2.5: 扫描一层子目录中的 docker-compose 文件（记录到 signals，不展开）
    skipped_compose: list[str] = []
    try:
        for sub in sorted(os.listdir(root)):
            if sub.startswith(".") or sub in {"node_modules", "dist", "build", "target",
                                              ".git", ".cds-repos", "venv", ".venv"}:
                continue
            sub_path = os.path.join(root, sub)
            if not os.path.isdir(sub_path):
                continue
            for fname in os.listdir(sub_path):
                if fname.startswith("docker-compose") and fname.endswith((".yml", ".yaml")):
                    skipped_compose.append(f"{sub}/{fname}")
    except Exception:
        pass
    if skipped_compose:
        signals["skippedComposeFiles"] = skipped_compose

    # 优先级 3: monorepo 扫描 + 骨架兜底
    modules = _detect_modules(root)
    signals["modules"] = [{"dir": m["dir"], "kind": m["kind"]} for m in modules]
    # Issue #561 / #560:把每个 java 模块的 JDK 版本 / 端口 / 运行时依赖暴露给 Agent
    java_signals: list[dict] = []
    aggregated_deps: set[str] = set()
    warnings: list[str] = []
    for m in modules:
        if m.get("kind") != "java":
            continue
        info = {
            "service": m.get("_service_name") or m.get("dir"),
            "javaVersion": m.get("_java_version"),
            "image": m.get("image"),
            "port": m.get("port"),
        }
        run_args = m.get("_spring_run_args") or {}
        if run_args.get("profile"):
            info["profile"] = run_args["profile"]
        if run_args.get("needsTls12"):
            info["needsTls12"] = True
        deps = m.get("_runtime_deps") or {}
        missing = [k for k, v in deps.items() if v]
        if missing:
            info["runtimeDeps"] = missing
            for d in missing:
                aggregated_deps.add(d)
        java_signals.append(info)
        if not m.get("_java_version"):
            warnings.append(
                f"{info['service']}: 未在 pom 中识别 java.version,默认 JDK17"
                "; 如需 Java 8/11/21 请显式声明"
            )
    if java_signals:
        signals["javaModules"] = java_signals
    if aggregated_deps:
        signals["missingInfra"] = sorted(aggregated_deps)
        warnings.append(
            "后端检测到 " + ", ".join(sorted(aggregated_deps))
            + " 配置但 compose 未生成对应 infra; 请人工补齐或复用共享 infra"
        )
    # Issue #560:Vite 前端引用 VITE_*_API_* env 但 compose 是否注入,聚合为 signals
    vite_modules: list[dict] = []
    for m in modules:
        if m.get("kind") != "node":
            continue
        sub_full = os.path.join(root, m["dir"]) if m["dir"] != "." else root
        keys = _detect_vite_api_env_keys(sub_full)
        if keys:
            vite_modules.append({"service": m.get("dir"), "apiEnvKeys": keys})
    if vite_modules:
        signals["frontendApiEnv"] = vite_modules
        # 没有 java 服务时,前端 env 没法自动指向,提醒用户
        has_java = any(m.get("kind") == "java" for m in modules)
        if not has_java:
            warnings.append(
                "前端引用 VITE_*_API_* env 但本仓库未识别后端服务,"
                "请人工在 environment 段填写 API 地址"
            )
    # Issue #544 / mdimp 缺陷 #2:嵌套子目录 docker-compose 实际合并 infra 进生成 YAML
    # 不只是标 partial,把 mysql/redis/rabbitmq 等 service 真的拿过来
    # Issue #567 缺陷 #6:嵌套 compose 合并时,把 service.volumes / build.context 里
    # 的相对路径 (./xxx) 前缀重写成 <nested-dir>/xxx,否则 docker compose up 从项目根
    # 找 ./docker/mysql/init 会 ENOENT(实际文件在 imp-platform/docker/mysql/init)
    merged_nested_infra: dict[str, dict] = {}
    merged_from_files: list[str] = []
    if skipped_compose:
        for rel in skipped_compose:
            full = os.path.join(root, rel)
            nested_dir = os.path.dirname(rel).replace(os.sep, "/")  # imp-platform
            try:
                nested_services = _parse_compose_services(full) or {}
            except Exception:
                continue
            for name, svc in nested_services.items():
                if not isinstance(svc, dict):
                    continue
                image = svc.get("image", "") or ""
                # 只合并 infra(命中 _INFRA_TEMPLATES),应用 service 由 monorepo 扫描负责
                if not _is_infra_image(image):
                    continue
                # 同名优先保留先到的(避免多个嵌套 compose 撞名)
                if name in merged_nested_infra:
                    continue
                # Issue #567 缺陷 #6:相对路径 volumes 前缀重写
                if nested_dir:
                    svc = _rewrite_compose_relative_paths(svc, nested_dir)
                merged_nested_infra[name] = svc
            if rel not in merged_from_files:
                merged_from_files.append(rel)
        if merged_nested_infra:
            signals["mergedInfraFromNested"] = sorted(merged_nested_infra.keys())
            signals["mergedFromFiles"] = merged_from_files
        # 仍标 partial,部署者需复核合并质量(端口/挂载等可能与 CDS 共享 infra 不一致)
        signals["status"] = "partial"
        signals["partialReason"] = (
            f"子目录存在 {len(skipped_compose)} 个 docker-compose 文件,"
            f"已自动合并 {len(merged_nested_infra)} 个 infra service;"
            "请复核端口与挂载是否与 CDS 共享 infra 一致"
        )
    if warnings:
        signals.setdefault("warnings", []).extend(warnings)
        # 有 warning 一律降为 partial,Agent 不能盲目把它当成完整 compose 部署
        signals["status"] = "partial"
    # Issue #544 / #561 / #566 缺陷 #3:对 missingInfra 自动生成 infra service
    # 来源:1) scan 检测到的 mysql/redis/rabbitmq/minio 等关键字 → _INFRA_TEMPLATES
    #      2) 嵌套 compose 已合并的 service(跳过同类,避免重复)
    auto_infra_services: dict[str, dict] = {}
    auto_infra_added: list[str] = []
    nested_infra_kinds = set()
    for svc in merged_nested_infra.values():
        tpl = _find_infra_template(svc.get("image", "") or "")
        if tpl:
            nested_infra_kinds.add(tpl["name"])
    for dep in sorted(aggregated_deps):
        # 已经在嵌套 compose 中合并过的同类 infra,不再重复生成
        if dep in nested_infra_kinds:
            continue
        # v0.6.6:nacos 现在有标准 infra template(standalone + 鉴权关闭),走通用流程
        # 找模板:redis → _INFRA_TEMPLATES.match=["redis"]
        tpl = None
        for t in _INFRA_TEMPLATES:
            if dep in t["match"] or dep == t["name"]:
                tpl = t
                break
        if not tpl:
            continue
        # 用 template 名做 service 名(redis/mysql/...),避免和 monorepo 服务撞名
        if tpl["name"] in auto_infra_services:
            continue
        svc_def: dict = {"image": tpl["image"]}
        if tpl.get("service_env"):
            svc_def["environment"] = dict(tpl["service_env"])
        if tpl.get("service_command"):
            svc_def["command"] = tpl["service_command"]
        svc_def["ports"] = [tpl["container_port"]]
        # x-cds-auto: 标记为 cdscli 自动生成,Agent / 部署者一眼看到不是手写
        svc_labels = {"cds.auto-generated": "true",
                      "cds.source": f"missingInfra={dep}"}
        # v0.6.6:模板可声明额外 labels(如 nacos 要 cds.no-http-readiness 跳 HTTP probe)
        if tpl.get("service_labels"):
            svc_labels.update(tpl["service_labels"])
        svc_def["labels"] = svc_labels
        auto_infra_services[tpl["name"]] = svc_def
        auto_infra_added.append(tpl["name"])
    if auto_infra_added:
        signals["autoInfraGenerated"] = sorted(auto_infra_added)

    # 把 nested + auto-generated infra 合并;同名时 nested 优先(用户手写优先级更高)
    final_infra = dict(auto_infra_services)
    for name, svc in merged_nested_infra.items():
        final_infra[name] = svc

    # Issue #567 缺陷 #7:抑制已被合并/自动生成的 infra 在 missingInfra/warnings 中的噪音
    # 计算实际还缺的 infra:aggregated_deps - (nested + auto-generated)
    covered_kinds = set(nested_infra_kinds) | set(auto_infra_added)
    truly_missing = sorted(d for d in aggregated_deps if d not in covered_kinds)
    if covered_kinds:
        if truly_missing:
            signals["missingInfra"] = truly_missing
            # 重写 warnings:把列表中提到的"全部 deps"改成"真正还缺的"
            new_warnings = []
            for w in (signals.get("warnings") or []):
                if "后端检测到" in w and "compose 未生成对应 infra" in w:
                    new_warnings.append(
                        "后端检测到 " + ", ".join(truly_missing) +
                        " 配置但 compose 未生成对应 infra; 请人工补齐或复用共享 infra"
                    )
                else:
                    new_warnings.append(w)
            signals["warnings"] = new_warnings
        else:
            # 完全覆盖,清掉 missingInfra/warnings 噪音(verify 不再 WARN scan-missing-infra/scan-warning)
            signals.pop("missingInfra", None)
            old = signals.get("warnings") or []
            kept = [w for w in old if not (
                "后端检测到" in w and "compose 未生成对应 infra" in w
            )]
            if kept:
                signals["warnings"] = kept
            else:
                signals.pop("warnings", None)

    yaml_content = _yaml_from_modules(root, modules,
                                      infra_services=final_infra,
                                      scan_signals=signals)
    signals["source"] = "monorepo-scan" if modules else "skeleton"
    _emit_scan_result(args, yaml_content, signals,
                      note=f"通过子目录扫描识别 {len(modules)} 个模块" if modules
                           else "未识别已知栈，输出骨架 YAML，请手动补全")
    return


# ── cdscli scan 辅助函数（2026-04-30 Week 4.8 Round 3） ──

def _rewrite_compose_relative_paths(svc: dict, nested_dir: str) -> dict:
    """Issue #567 缺陷 #6:嵌套 docker-compose.yml 合并到顶层 cds-compose.yml 时,
    把 service 里所有 ./xxx 相对路径重写成 <nested_dir>/xxx,让 docker compose up
    从项目根能正确找到 init.sql / conf.d 等挂载点。

    覆盖字段: volumes (str list), build.context (str / dict), env_file (str / list)。
    nested_dir 已经是相对项目根的 posix 路径(如 'imp-platform')。
    """
    if not nested_dir:
        return svc

    def _rewrite(p):
        if not isinstance(p, str):
            return p
        if p == ".":
            return f"./{nested_dir}"
        if p.startswith("./"):
            return f"./{nested_dir}/{p[2:]}"
        # 已是绝对路径或命名 volume(无 ./ 前缀)不改
        return p

    out = dict(svc)
    # volumes: ["./docker/mysql/init:/docker-entrypoint-initdb.d:ro", ...]
    vols = out.get("volumes")
    if isinstance(vols, list):
        new_vols = []
        for v in vols:
            if isinstance(v, str) and ":" in v:
                parts = v.split(":")
                parts[0] = _rewrite(parts[0])
                new_vols.append(":".join(parts))
            elif isinstance(v, dict):
                # long-form: { type: bind, source: ./xxx, target: /yyy }
                vd = dict(v)
                if vd.get("source"):
                    vd["source"] = _rewrite(vd["source"])
                new_vols.append(vd)
            else:
                new_vols.append(v)
        out["volumes"] = new_vols
    # build: ./xxx | { context: ./xxx, dockerfile: ... }
    build = out.get("build")
    if isinstance(build, str):
        out["build"] = _rewrite(build)
    elif isinstance(build, dict) and build.get("context"):
        bd = dict(build)
        bd["context"] = _rewrite(bd["context"])
        out["build"] = bd
    # env_file: "./xxx" | ["./xxx", ...]
    ef = out.get("env_file")
    if isinstance(ef, str):
        out["env_file"] = _rewrite(ef)
    elif isinstance(ef, list):
        out["env_file"] = [_rewrite(x) for x in ef]
    return out


def _parse_compose_services(path: str) -> dict:
    """解析 docker-compose 的 services 段。优先 PyYAML，无则用正则兜底（够用）。"""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    try:
        import yaml  # type: ignore
        doc = yaml.safe_load(text) or {}
        return doc.get("services") or {}
    except ImportError:
        return _parse_compose_services_regex(text)


def _strip_dot_slash(p: str) -> str:
    """Strip a leading literal './' prefix from a path string.

    Bugbot fix(PR #521 第十二轮 Bug 2)— Python 的 `str.lstrip("./")` 是按
    *字符集* 删,不是按 *前缀* 删:
        '../sibling'.lstrip('./')   == 'sibling'   (错!应该保留 ../)
        '...hidden'.lstrip('./')    == 'hidden'    (错!应该保留 ...)
        './app'.lstrip('./')        == 'app'       (碰巧正确)
    必须用 removeprefix(Python 3.9+) 或显式 startswith 切片。
    """
    if p.startswith("./"):
        return p[2:]
    return p


# Bugbot fix(PR #521 第十二轮 Bug 1)— 与 TS isAppSourceMount(cds/src/services/
# compose-parser.ts)对齐:任意 ./ 挂载不算 app source,要排除 init script /
# 配置文件挂载,否则 mysql 这种自带 ./init.sql:/docker-entrypoint-initdb.d/init.sql
# 的 infra 会被 verify 误判为 app,_verify_schemaful_db_migration 漏 schemaful
# DB 检测,触发假 app-specific 错误。
_INIT_SCRIPT_TARGET_PREFIXES = (
    "/docker-entrypoint-initdb.d/",  # mysql / postgres / mongodb 标准初始化目录
    "/etc/",                          # 通用配置(redis.conf 等)
    "/usr/local/etc/",                # 通用配置变种
    "/init/",                         # 自定义 init 脚本约定路径
)
_CONFIG_FILE_EXT_RE_PATTERN = r"\.(sql|conf|cnf|ini|json|ya?ml|env|sh|properties|xml|toml)$"


def _is_app_source_mount(volume_str: str) -> bool:
    """单条 docker-compose 挂载条目是不是"应用源码"挂载(排除 init/配置)。

    与 TS isAppSourceMount 完全对齐。`./init.sql:/docker-entrypoint-initdb.d/init.sql:ro`
    类配置挂载返回 False,普通 ./app:/app 类源码挂载返回 True。
    """
    import re
    if not isinstance(volume_str, str):
        return False
    parts = volume_str.split(":")
    source = parts[0]
    target = parts[1] if len(parts) > 1 else ""
    if not (source.startswith("./") or source == "."):
        return False
    # 1. 目标路径属于 init / 配置目录 → 不算 app source
    if any(target.startswith(t) for t in _INIT_SCRIPT_TARGET_PREFIXES):
        return False
    # 2. 源路径以单文件配置扩展名结尾 → 不算 app source
    if re.search(_CONFIG_FILE_EXT_RE_PATTERN, source, re.IGNORECASE):
        return False
    return True


def _rewrite_env_value_with_infra_aliases(value: str, present_infra_names: set[str]) -> str:
    """把 docker-compose 里硬编码的连接字符串替换成 cdscli 模板的 ${VAR} 引用。

    例:
      `mongodb://admin:admin123@mongodb:27017` → `${MONGODB_URL}`
      `mysql://app:secret@mysql:3306/app`     → `${DATABASE_URL}`
      `redis://redis:6379`                     → `${REDIS_URL}`

    只替换:
      - 命中 _INFRA_TEMPLATES 任一已识别 infra(pres_infra_names 里有)
      - 用 service name 作 host 部分(确保引用的是同项目容器)

    没命中模板 / 没识别 infra 的连接串保持原样,carry over。
    """
    if not value or not isinstance(value, str):
        return value
    import re
    # mongodb://user:pass@host:port[/db][?...]
    # mysql://user:pass@host:port[/db]
    # redis://[:pass@]host:port[/db]
    # postgres://user:pass@host:port/db
    patterns: list[tuple[str, str, str]] = [
        # (regex, alias_var, infra_template_name) — alias 用 CDS_* 前缀(Phase 8 命名规范)
        (r"^mongodb(\+srv)?://[^@]+@(\w[\w-]*):", "CDS_MONGODB_URL", "mongodb"),
        (r"^mysql://[^@]+@(\w[\w-]*):", "CDS_DATABASE_URL", "mysql"),
        (r"^postgresql?://[^@]+@(\w[\w-]*):", "CDS_DATABASE_URL", "postgres"),
        (r"^redis://[^@]*@?(\w[\w-]*):", "CDS_REDIS_URL", "redis"),
        (r"^amqp://[^@]+@(\w[\w-]*):", "CDS_AMQP_URL", "rabbitmq"),
    ]
    for pat, alias, tpl_name in patterns:
        m = re.match(pat, value)
        if m and tpl_name in present_infra_names:
            return f"${{{alias}}}"
    return value


def _parse_compose_services_regex(text: str) -> dict:
    """无 PyYAML 时的正则降级:抽取 services 段下每个 service 的 image / build 配置。"""
    import re
    services: dict[str, dict] = {}

    def parse_inline_list(raw: str) -> list[str]:
        """Parse a simple YAML inline string list: ['a', "b", c]."""
        items: list[str] = []
        for part in raw.split(","):
            item = part.strip()
            if not item:
                continue
            items.append(item.strip().strip('"\''))
        return items

    # 找到 services: 段
    m = re.search(r"^services:\s*\n", text, re.MULTILINE)
    if not m:
        return services
    body = text[m.end():]
    # 直到下一个顶层 key（^[a-z]）
    end_m = re.search(r"^[a-z][\w-]*:\s*$", body, re.MULTILINE)
    if end_m:
        body = body[:end_m.start()]

    # 按 service 名称切块（缩进 2 空格的 key）
    blocks = re.split(r"\n  ([a-z][\w-]+):\s*\n", "\n" + body)
    # blocks[0] 是 services: 之前的文本（弃）；之后两两成对：name, content
    for i in range(1, len(blocks) - 1, 2):
        name = blocks[i]
        content = blocks[i + 1]
        svc: dict[str, Any] = {"name": name}
        img = re.search(r"^\s{4}image:\s*(.+)$", content, re.MULTILINE)
        if img:
            svc["image"] = img.group(1).strip().strip('"\'')
        build = re.search(r"^\s{4}build:", content, re.MULTILINE)
        if build:
            ctx = re.search(r"^\s{6}context:\s*(.+)$", content, re.MULTILINE)
            df = re.search(r"^\s{6}dockerfile:\s*(.+)$", content, re.MULTILINE)
            svc["build"] = {
                "context": (ctx.group(1).strip().strip('"\'') if ctx else "."),
                "dockerfile": (df.group(1).strip().strip('"\'') if df else None),
            }
        ports_block = re.search(r"^ {4}ports:\s*\n((?: {6}-\s+.+(?:\n|$))+)", content, re.MULTILINE)
        if ports_block:
            svc["ports"] = [
                p.strip().lstrip("- ").strip().strip('"\'')
                for p in ports_block.group(1).strip().split("\n") if p.strip()
            ]
        else:
            ports_inline = re.search(r"^\s{4}ports:\s*\[(.+)\]\s*$", content, re.MULTILINE)
            if ports_inline:
                svc["ports"] = parse_inline_list(ports_inline.group(1))
        # Phase 3:解析 volumes 段(给 yaml carry-over 用)。只支持短格式 list:
        #   volumes:
        #     - "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro"
        #     - mysql_data:/var/lib/mysql
        # 长格式 dict({source, target}) 兜底跑不到这里(yaml.safe_load 优先),不补。
        volumes_block = re.search(r"^ {4}volumes:\s*\n((?: {6}-\s+.+(?:\n|$))+)", content, re.MULTILINE)
        if volumes_block:
            svc["volumes"] = [
                p.strip().lstrip("- ").strip().strip('"\'')
                for p in volumes_block.group(1).strip().split("\n") if p.strip()
            ]
        else:
            volumes_inline = re.search(r"^\s{4}volumes:\s*\[(.+)\]\s*$", content, re.MULTILINE)
            if volumes_inline:
                svc["volumes"] = parse_inline_list(volumes_inline.group(1))
        # Phase 3:解析 environment 段(给 _rewrite_env_value_with_infra_aliases 用)
        # 支持两种 yaml 形式 — dict 和 list
        env_dict_block = re.search(r"^ {4}environment:\s*\n((?: {6}\w[\w_-]*:\s*.+(?:\n|$))+)", content, re.MULTILINE)
        if env_dict_block:
            env: dict[str, str] = {}
            for line in env_dict_block.group(1).split("\n"):
                m = re.match(r"^\s{6}(\w[\w_-]*):\s*(.+)$", line)
                if m:
                    env[m.group(1)] = m.group(2).strip().strip('"\'')
            if env:
                svc["environment"] = env
        else:
            env_list_block = re.search(r"^\s{4}environment:\s*\n((?:\s{6}-\s+.+\n)+)", content, re.MULTILINE)
            if env_list_block:
                svc["environment"] = [
                    p.strip().lstrip("- ").strip().strip('"\'')
                    for p in env_list_block.group(1).strip().split("\n") if p.strip()
                ]
        # Phase 3:解析 working_dir / command / depends_on(carry-over 用)
        wd = re.search(r"^\s{4}working_dir:\s*(.+)$", content, re.MULTILINE)
        if wd:
            svc["working_dir"] = wd.group(1).strip().strip('"\'')
        cmd = re.search(r"^\s{4}command:\s*(.+)$", content, re.MULTILINE)
        if cmd:
            svc["command"] = cmd.group(1).strip().strip('"\'')
        # depends_on:list 简写 [a, b] 或 - a / - b 缩进列表
        deps_inline = re.search(r"^\s{4}depends_on:\s*\[(.+)\]\s*$", content, re.MULTILINE)
        if deps_inline:
            svc["depends_on"] = [d.strip().strip('"\'') for d in deps_inline.group(1).split(",") if d.strip()]
        else:
            deps_block = re.search(r"^\s{4}depends_on:\s*\n((?:\s{6}-\s+.+\n)+)", content, re.MULTILINE)
            if deps_block:
                svc["depends_on"] = [
                    p.strip().lstrip("- ").strip().strip('"\'')
                    for p in deps_block.group(1).strip().split("\n") if p.strip()
                ]
        services[name] = svc
    return services


# 基础设施 image 关键词 → 是否为 infra
# ── 基础设施模板穷举(2026-05-01,Railway-style)──────────────────
# 每个模板:image / 容器 port / 容器初始化所需 env / 应用侧连接串。
# 命中规则:image name 包含任一 match_keywords 即认为是该 infra。
# password_keys 自动用 secrets.token_urlsafe(16) 生成,用户可改;
# 用 ${VAR} 引用让 service 段和 x-cds-env 段两边共享同一字符串。
#
# Phase 8 命名规范(2026-05-01):
#   - x-cds-env 顶层 key(global_env 第一项)**全部** CDS_ 前缀,
#     这是"CDS 自动生成 / 命名空间归 CDS 所有"的契约,避免和用户原项目
#     env 撞名(用户可能本来就有 MYSQL_PASSWORD,但和 CDS 生成的语义不同)
#   - service_env(容器内部)依然用上游 image 要求的 env 名(MYSQL_ROOT_PASSWORD
#     / POSTGRES_USER 等),value 引用 ${CDS_*} —— image 不变,容器内行为不变
#   - 应用侧连接串(URL)走 CDS_* 前缀,应用 env 引用 ${CDS_DATABASE_URL}
#     就能拿到完整字符串。一致性、不冲突、明示所有权
_INFRA_TEMPLATES: list[dict] = [
    {
        "name": "mongodb",
        "match": ["mongo"],
        "image": "mongo:8.0",
        "container_port": "27017",
        "service_env": {
            "MONGO_INITDB_ROOT_USERNAME": "${CDS_MONGO_USER}",
            "MONGO_INITDB_ROOT_PASSWORD": "${CDS_MONGO_PASSWORD}",
        },
        "global_env": [
            ("CDS_MONGO_USER", "root", False, "MongoDB root 用户名(CDS 命名空间)"),
            ("CDS_MONGO_PASSWORD", None, True, "MongoDB root 密码(CDS 自动随机生成)"),
            ("CDS_MONGODB_URL", "mongodb://${CDS_MONGO_USER}:${CDS_MONGO_PASSWORD}@mongodb:27017/admin?authSource=admin", False, "应用侧连接串(CDS 推导,可被应用 env 引用)"),
        ],
    },
    {
        "name": "redis",
        "match": ["redis"],
        "image": "redis:7-alpine",
        "container_port": "6379",
        "service_env": {},
        "service_command": "redis-server --requirepass ${CDS_REDIS_PASSWORD}",
        "global_env": [
            ("CDS_REDIS_PASSWORD", None, True, "Redis 密码(CDS 自动随机生成)"),
            ("CDS_REDIS_URL", "redis://:${CDS_REDIS_PASSWORD}@redis:6379/0", False, "应用侧连接串(CDS 推导)"),
        ],
    },
    {
        "name": "postgres",
        "match": ["postgres", "timescale"],
        "image": "postgres:16-alpine",
        "container_port": "5432",
        "schemaful": True,  # Phase 3:命中 schemaful DB 时,app command 自动加 wait-for 前缀
        "init_sql_path": "/docker-entrypoint-initdb.d/init.sql",
        "service_env": {
            "POSTGRES_USER": "${CDS_POSTGRES_USER}",
            "POSTGRES_PASSWORD": "${CDS_POSTGRES_PASSWORD}",
            "POSTGRES_DB": "${CDS_POSTGRES_DB}",
        },
        "global_env": [
            ("CDS_POSTGRES_USER", "postgres", False, "Postgres 用户名(CDS 命名空间)"),
            ("CDS_POSTGRES_PASSWORD", None, True, "Postgres 密码(CDS 自动随机生成)"),
            ("CDS_POSTGRES_DB", "app", False, "默认数据库(CDS 命名空间)"),
            ("CDS_DATABASE_URL", "postgresql://${CDS_POSTGRES_USER}:${CDS_POSTGRES_PASSWORD}@postgres:5432/${CDS_POSTGRES_DB}", False, "应用侧连接串(CDS 推导)"),
        ],
    },
    {
        "name": "mysql",
        "match": ["mysql", "mariadb"],
        "image": "mysql:8",
        "container_port": "3306",
        "schemaful": True,  # Phase 3:命中 schemaful DB 时,app command 自动加 wait-for 前缀
        "init_sql_path": "/docker-entrypoint-initdb.d/init.sql",
        "service_env": {
            "MYSQL_ROOT_PASSWORD": "${CDS_MYSQL_ROOT_PASSWORD}",
            "MYSQL_DATABASE": "${CDS_MYSQL_DATABASE}",
            "MYSQL_USER": "${CDS_MYSQL_USER}",
            "MYSQL_PASSWORD": "${CDS_MYSQL_PASSWORD}",
        },
        "global_env": [
            ("CDS_MYSQL_ROOT_PASSWORD", None, True, "MySQL root 密码(CDS 自动随机生成)"),
            ("CDS_MYSQL_DATABASE", "app", False, "默认数据库(CDS 命名空间)"),
            ("CDS_MYSQL_USER", "app", False, "应用专用用户(CDS 命名空间)"),
            ("CDS_MYSQL_PASSWORD", None, True, "应用密码(CDS 自动随机生成)"),
            ("CDS_DATABASE_URL", "mysql://${CDS_MYSQL_USER}:${CDS_MYSQL_PASSWORD}@mysql:3306/${CDS_MYSQL_DATABASE}", False, "应用侧连接串(CDS 推导)"),
        ],
    },
    {
        "name": "sqlserver",
        "match": ["mssql", "sql-server", "mcr.microsoft.com/mssql"],
        "image": "mcr.microsoft.com/mssql/server:2022-latest",
        "container_port": "1433",
        "schemaful": True,  # Phase 3:命中 schemaful DB 时,app command 自动加 wait-for 前缀
        "service_env": {
            "ACCEPT_EULA": "Y",
            "MSSQL_SA_PASSWORD": "${CDS_SQLSERVER_SA_PASSWORD}",
            "MSSQL_PID": "Developer",
        },
        "global_env": [
            ("CDS_SQLSERVER_SA_PASSWORD", None, True, "SQL Server SA 密码(CDS 自动随机生成,长度 22,含字母+数字+`-`/`_`,符合默认密码策略)"),
            ("CDS_SQLSERVER_URL", "Server=sqlserver,1433;Database=master;User Id=sa;Password=${CDS_SQLSERVER_SA_PASSWORD};TrustServerCertificate=True;", False, "ADO.NET 连接串(CDS 推导)"),
        ],
    },
    {
        "name": "clickhouse",
        "match": ["clickhouse"],
        "image": "clickhouse/clickhouse-server:24-alpine",
        "container_port": "8123",
        "service_env": {
            "CLICKHOUSE_USER": "${CDS_CLICKHOUSE_USER}",
            "CLICKHOUSE_PASSWORD": "${CDS_CLICKHOUSE_PASSWORD}",
            "CLICKHOUSE_DB": "${CDS_CLICKHOUSE_DB}",
            "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT": "1",
        },
        "global_env": [
            ("CDS_CLICKHOUSE_USER", "default", False, "ClickHouse 用户名(CDS 命名空间)"),
            ("CDS_CLICKHOUSE_PASSWORD", None, True, "ClickHouse 密码(CDS 自动随机生成)"),
            ("CDS_CLICKHOUSE_DB", "default", False, "默认数据库(CDS 命名空间)"),
            ("CDS_CLICKHOUSE_URL", "http://${CDS_CLICKHOUSE_USER}:${CDS_CLICKHOUSE_PASSWORD}@clickhouse:8123/${CDS_CLICKHOUSE_DB}", False, "应用侧 HTTP 连接串(CDS 推导)"),
        ],
    },
    {
        "name": "rabbitmq",
        "match": ["rabbitmq"],
        "image": "rabbitmq:3-management-alpine",
        "container_port": "5672",
        "service_env": {
            "RABBITMQ_DEFAULT_USER": "${CDS_RABBITMQ_USER}",
            "RABBITMQ_DEFAULT_PASS": "${CDS_RABBITMQ_PASSWORD}",
        },
        "global_env": [
            ("CDS_RABBITMQ_USER", "guest", False, "RabbitMQ 用户名(CDS 命名空间)"),
            ("CDS_RABBITMQ_PASSWORD", None, True, "RabbitMQ 密码(CDS 自动随机生成)"),
            ("CDS_AMQP_URL", "amqp://${CDS_RABBITMQ_USER}:${CDS_RABBITMQ_PASSWORD}@rabbitmq:5672/", False, "AMQP 连接串(CDS 推导)"),
        ],
    },
    {
        "name": "elasticsearch",
        "match": ["elasticsearch", "elastic"],
        "image": "docker.elastic.co/elasticsearch/elasticsearch:8.11.0",
        "container_port": "9200",
        "service_env": {
            "discovery.type": "single-node",
            "xpack.security.enabled": "true",
            "ELASTIC_PASSWORD": "${CDS_ELASTIC_PASSWORD}",
            "ES_JAVA_OPTS": "-Xms512m -Xmx512m",
        },
        "global_env": [
            ("CDS_ELASTIC_PASSWORD", None, True, "Elasticsearch elastic 用户密码(CDS 自动随机生成)"),
            ("CDS_ELASTICSEARCH_URL", "http://elastic:${CDS_ELASTIC_PASSWORD}@elasticsearch:9200", False, "应用侧连接串(CDS 推导)"),
        ],
    },
    {
        "name": "minio",
        "match": ["minio"],
        "image": "minio/minio:latest",
        "container_port": "9000",
        "service_env": {
            "MINIO_ROOT_USER": "${CDS_MINIO_ROOT_USER}",
            "MINIO_ROOT_PASSWORD": "${CDS_MINIO_ROOT_PASSWORD}",
        },
        "service_command": "server /data --console-address :9001",
        "global_env": [
            ("CDS_MINIO_ROOT_USER", "minioadmin", False, "MinIO 管理用户(同时是 S3 access key,CDS 命名空间)"),
            ("CDS_MINIO_ROOT_PASSWORD", None, True, "MinIO 密码(CDS 自动随机生成,同时是 S3 secret key)"),
            ("CDS_S3_ENDPOINT", "http://minio:9000", False, "S3 API endpoint(CDS 推导)"),
            ("CDS_S3_ACCESS_KEY", "${CDS_MINIO_ROOT_USER}", False, "S3 access key(CDS 推导)"),
            ("CDS_S3_SECRET_KEY", "${CDS_MINIO_ROOT_PASSWORD}", False, "S3 secret key(CDS 推导)"),
        ],
    },
    {
        "name": "nats",
        "match": ["nats"],
        "image": "nats:2-alpine",
        "container_port": "4222",
        "service_env": {},
        "global_env": [
            ("CDS_NATS_URL", "nats://nats:4222", False, "NATS 连接串(无密码,CDS 命名空间)"),
        ],
    },
    {
        "name": "memcached",
        "match": ["memcached"],
        "image": "memcached:1-alpine",
        "container_port": "11211",
        "service_env": {},
        "global_env": [
            ("CDS_MEMCACHED_URL", "memcached:11211", False, "Memcached 连接串(CDS 命名空间)"),
        ],
    },
    {
        "name": "nginx",
        "match": ["nginx"],
        "image": "nginx:alpine",
        "container_port": "80",
        "service_env": {},
        "global_env": [],
    },
    # v0.6.6:Spring Cloud 项目(myTapd 等)需要 nacos 拿 datasource URL,
    # 否则 'Failed to configure a DataSource: url attribute is not specified'。
    # standalone + 关闭鉴权,带 cds.no-http-readiness 跳过 HTTP probe 误判。
    {
        "name": "nacos",
        "match": ["nacos"],
        "image": "nacos/nacos-server:v2.3.2-slim",
        "container_port": "8848",
        "service_env": {
            "MODE": "standalone",
            "NACOS_AUTH_ENABLE": "false",
        },
        "service_labels": {
            "cds.no-http-readiness": "true",
            "cds.readiness-timeout": "180",
        },
        "global_env": [],
    },
]


def _find_infra_template(image: str) -> dict | None:
    """根据 image 名查找匹配的基础设施模板;无匹配返回 None。"""
    if not image:
        return None
    img = image.lower().split(":")[0]
    for tpl in _INFRA_TEMPLATES:
        for kw in tpl["match"]:
            if kw in img:
                return tpl
    return None


def _is_infra_image(image: str) -> bool:
    return _find_infra_template(image) is not None


def _gen_password() -> str:
    """生成强随机密码:URL-safe + 长度 22(token_urlsafe(16) 出 22 字符)。

    Phase 3(2026-05-01)改动:**移除原 `!` 后缀**。
    历史:`!` 是为兜底 SQL Server 严格策略加的,但它出现在密码里就要 url-encode
    才能塞进连接串(如 `mysql://user:P@ss!@host`),实战中 url-encode 不到位
    导致 mysql client 解析失败 → "Access denied" 假象。token_urlsafe(16) 已含
    A-Z / a-z / 0-9 / - / _ 共 4 类字符,长度 22 远超 SQL Server 要求的 8 位
    最低长度 + 3 类字符(默认策略),完全合规且不需 url-encode。

    SQL Server 真要"必须含特殊字符"时,token_urlsafe 里的 `-` `_` 也算"非字母数字",
    一般能过策略校验。极端场景请在 cds-compose.yml 里手动改密码加 `!`(并自行
    url-encode 连接串)。
    """
    import secrets
    return secrets.token_urlsafe(16)


# Phase 8 — env 三色分类:导入后 CDS UI 强制用户感知 required;auto/infra-derived 自动跑
# - auto          : cdscli 自动生成或自动给定值(密码 / 默认值如 user='postgres' / 应用侧连接串模板)
# - required      : 用户必须填写,不填则 deploy block(value 是空 / TODO / 显式 required 标记)
# - infra-derived : 引用其他 ${VAR} 推导(连接串等),由 CDS 内部 infra 决定,用户不需要管
_REQUIRED_VALUE_MARKERS = ("TODO", "<填写", "<your-", "<YOUR_", "REPLACE_ME", "请填写")
# 这些 key 关键词命中且 value 为空 → required(用户必填的密钥/secret)
_SECRET_KEY_PATTERNS = ("PASSWORD", "SECRET", "TOKEN", "API_KEY", "APIKEY",
                        "ACCESS_KEY", "PRIVATE_KEY",
                        "OAUTH", "SMTP", "STRIPE", "TWILIO",
                        "SENDGRID", "MAILGUN", "S3_ACCESS_KEY", "S3_SECRET_KEY",
                        "AWS_ACCESS", "AWS_SECRET", "GOOGLE_CLIENT", "GITHUB_CLIENT")
# Bugbot fix(PR #521 第十三轮 Bug 2 后续)— 加 ACCESS_KEY 兜底,
# 之前 AI_ACCESS_KEY / WEBHOOK_ACCESS_KEY 等都漏检。Bug 2 把 fallback envs
# 路由经 _classify_env_kind 后,这个兜底必须能 catch 这类常见命名。


def _classify_env_kind(key: str, default: str | None, is_password: bool) -> tuple[str, str]:
    """分类 env 变量:返回 (kind, hint)。

    - is_password=True              → auto(cdscli 自动生成强密码)
    - default 含 "TODO" / "<填写>" → required(用户必填,deploy 前 block)
    - default 含 ${VAR}            → infra-derived(由 CDS infra 推导)
    - default 为空 + key 命中 _SECRET_KEY_PATTERNS → required
    - 其他(字面量默认值)           → auto
    """
    if is_password:
        return ("auto", "cdscli 自动生成的强密码")
    # Bugbot fix(PR #521 第十四轮 Bug 1)— ${VAR} 模板引用判定必须排在
    # 占位符 marker 检查之前。否则 `${REPLACE_ME_TOKEN}` 含子串 "REPLACE_ME"
    # 会被误归 required,而它实际是 infra-derived(由 CDS 自动推导),
    # 导致 deploy 被错误 block,让用户填一个本该自动算出来的值。
    if default and "${" in default:
        return ("infra-derived", "由 CDS 根据基础设施自动推导")
    # Bugbot fix(PR #521 第六轮)— case-insensitive,与 state.ts isPlaceholderValue
    # 保持一致。否则 cdscli 看 "Todo: fill" 不命中 → kind=auto;TS 后端看就命中
    # → 标 missing → 跨 boundary 不一致,占位符可能 silently 进容器
    if default:
        upper_default = default.upper()
        if any(m.upper() in upper_default for m in _REQUIRED_VALUE_MARKERS):
            return ("required", "请填写实际值")
    if not default:
        # Bugbot review:仅当 key 命中 secret 关键词(SECRET / PASSWORD / TOKEN /
        # KEY / PRIVATE / OAUTH / SMTP / API_KEY / S3_* / AWS_* 等)才标 required
        # 强制 deploy block;其它非密钥的空值变量(LOG_LEVEL / FEATURE_FLAGS 等)
        # 标 auto + 软提示,不阻塞 deploy(应用如果有内置默认或不依赖该 var,
        # 可以直接跑起来,不应该被 CDS 强制 block)
        key_upper = key.upper()
        if any(p in key_upper for p in _SECRET_KEY_PATTERNS):
            return ("required", f"请填写 {key}(密钥/凭据,可点「生成」按钮自动随机)")
        return ("auto", f"{key}(空值;应用若有内置默认可不填,或在 CDS UI 补充)")
    return ("auto", "默认值,可在 CDS UI 修改")


def _collect_required_envs_from_app_services(
    services: dict, app_names: list, present_global_keys: set
) -> dict:
    """扫描应用 service 的 environment 段,找出引用了 ${VAR} 但 VAR 不在
    cdscli 生成的 global_env_decls 里的变量 — 这些都是用户必填的。

    例如 Twenty docker-compose 里 server.environment 含:
      EMAIL_PASSWORD: ${EMAIL_PASSWORD}
      AUTH_GOOGLE_CLIENT_ID: ${AUTH_GOOGLE_CLIENT_ID}
    这两个 VAR 都没在 cdscli 模板里,本函数返回:
      {"EMAIL_PASSWORD": "", "AUTH_GOOGLE_CLIENT_ID": ""}
    主流程把它们注入 x-cds-env(空值)+ x-cds-env-meta(kind=required)。
    """
    import re
    found: dict[str, str] = {}
    # Bugbot fix(PR #521 第八轮)— 支持 mixed-case / lowercase env var 名,
    # docker-compose 常见 ${db_password} / ${Server__Port} 写法。POSIX env 名
    # 允许 [A-Za-z_][A-Za-z0-9_]*,跟着 docker-compose 的实际行为对齐
    var_re = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
    for name in app_names:
        svc = services.get(name) or {}
        env_section = svc.get("environment")
        env_pairs: list[tuple[str, str]] = []
        if isinstance(env_section, dict):
            env_pairs = [(str(k), str(v) if v is not None else "") for k, v in env_section.items()]
        elif isinstance(env_section, list):
            for item in env_section:
                if isinstance(item, str) and "=" in item:
                    k, _, v = item.partition("=")
                    env_pairs.append((k.strip(), v.strip()))
        for _, value in env_pairs:
            if not value:
                continue
            for m in var_re.finditer(value):
                var = m.group(1)
                fallback = m.group(2) or ""
                if var in present_global_keys:
                    continue
                # 跳过常见 docker-compose 内置(PWD / HOSTNAME 等)
                if var in ("PWD", "HOSTNAME", "PATH", "HOME", "USER"):
                    continue
                found.setdefault(var, fallback)
    return found


def _detect_app_port(svc: dict, root: str) -> tuple[str, str]:
    """启发式探测应用 service 的真实监听端口。

    Phase 3(2026-05-01)— 修 geo 实战根因 #5:webpack devServer.port=8000
    但 ports 段写 3000,proxy 直接 connection refused。

    优先级:
      1. compose 的 ports: 段(_first_port,既有行为),最权威
      2. webpack.config.js / webpack.config.ts 里的 devServer.port
      3. vite.config.{js,ts,mjs} 的 server.port
      4. package.json scripts 里 `--port N` / `-p N` / `PORT=N`
      5. .NET appsettings.Development.json 的 Kestrel.Endpoints.Http.Url
      6. .NET Properties/launchSettings.json 的 applicationUrl
      7. 兜底:返回 service 名 + image 推断的默认值(node→3000 / dotnet→5000)

    返回 (port, source) 元组,source 是命中的来源标识(给 signal 用)。
    """
    # 1. compose ports
    compose_port = _first_port(svc.get("ports") or [])
    if compose_port:
        return compose_port, "compose-ports"

    # 找应用源码目录(从 build context 或第一个相对 mount)
    src_dirs: list[str] = []
    build = svc.get("build")
    if isinstance(build, dict):
        ctx = build.get("context", ".")
        src_dirs.append(os.path.join(root, _strip_dot_slash(ctx)))
    elif isinstance(build, str):
        src_dirs.append(os.path.join(root, _strip_dot_slash(build)))
    for v in svc.get("volumes") or []:
        if not isinstance(v, str):
            continue
        host = v.split(":")[0]
        if host.startswith("./") or host == ".":
            src_dirs.append(os.path.join(root, _strip_dot_slash(host) or "."))
    if not src_dirs:
        src_dirs.append(root)

    import re
    for src in src_dirs:
        if not os.path.isdir(src):
            continue

        # 2. webpack
        for cand in ("webpack.config.js", "webpack.config.ts", "webpack.config.cjs", "webpack.config.mjs"):
            full = os.path.join(src, cand)
            if not os.path.exists(full):
                continue
            try:
                # Bugbot fix(PR #521 第九轮 Bug 4)— with-open 上下文管理,
                # 避免读异常时文件句柄泄漏(原 open(...).read() 写法,Python
                # 不保证立刻 close,且抛异常时 GC 才回收,扫描大仓库会累积)。
                with open(full, "r", encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except Exception:
                continue
            # Bugbot fix(PR #521 第五轮)— 删除全文 `port:\d+` 的 broad fallback。
            # 之前漏掉 devServer 块时,匹配任何 `port: 8080`(包括 proxy targets /
            # module federation port / 全局 webpack stats port),误返回错的端口。
            # 只信 devServer 块内的 port,失败就返空(让 _detect_app_port 走下一个
            # 候选 / 调用方决定不输出 ports 段)。
            m = re.search(r"devServer\s*:\s*\{[^}]*?port\s*:\s*(\d+)", text, re.DOTALL)
            if m:
                return m.group(1), f"webpack:{cand}"

        # 3. vite
        for cand in ("vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"):
            full = os.path.join(src, cand)
            if not os.path.exists(full):
                continue
            try:
                with open(full, "r", encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except Exception:
                continue
            server_body = _extract_js_object_body(text, "server")
            if server_body:
                raw_port = _extract_top_level_numeric_prop(server_body, "port", 5)
                if raw_port:
                    validated = _normalize_port(raw_port)
                    if validated:
                        return validated, f"vite:{cand}"

        # 4. package.json scripts
        pkg = os.path.join(src, "package.json")
        if os.path.exists(pkg):
            try:
                import json as _json
                with open(pkg, "r", encoding="utf-8") as f:
                    pkg_doc = _json.load(f)
                scripts = pkg_doc.get("scripts") or {}
                # 优先看 dev / start
                for key in ("dev", "start", "serve"):
                    cmd = scripts.get(key) or ""
                    if not isinstance(cmd, str):
                        continue
                    m = re.search(r"--port[=\s]+(\d+)", cmd) or re.search(r"\s-p[=\s]+(\d+)", cmd) \
                        or re.search(r"PORT=(\d+)", cmd)
                    if m:
                        return m.group(1), f"package.json:scripts.{key}"
            except Exception:
                pass

        # 5/6. .NET
        for cand in ("appsettings.Development.json", "appsettings.json"):
            full = os.path.join(src, cand)
            if not os.path.exists(full):
                continue
            try:
                import json as _json
                with open(full, "r", encoding="utf-8") as f:
                    doc = _json.load(f)
                kestrel = doc.get("Kestrel") or {}
                eps = kestrel.get("Endpoints") or {}
                for ep in eps.values():
                    url = ep.get("Url") or ep.get("url") or ""
                    m = re.search(r":(\d+)", str(url))
                    if m:
                        return m.group(1), f"dotnet:{cand}"
            except Exception:
                continue
        ls = os.path.join(src, "Properties", "launchSettings.json")
        if os.path.exists(ls):
            try:
                import json as _json
                with open(ls, "r", encoding="utf-8") as f:
                    doc = _json.load(f)
                profiles = doc.get("profiles") or {}
                for prof in profiles.values():
                    url = prof.get("applicationUrl") or ""
                    m = re.search(r":(\d+)", str(url))
                    if m:
                        return m.group(1), "dotnet:launchSettings.json"
            except Exception:
                pass

    # Bugbot fix(PR #521 第五轮)— 删除 image-based 兜底猜测。
    # 之前任何 service 都返回 ("3000", "default:fallback") → worker / 后台
    # 队列消费者(没 ports 段 + 不监听 HTTP)被强行 emit ports: ["3000"],
    # 误导 cdscli verify + proxy 错路由。返回 ("", "no-signal") 让调用方
    # 据此判断是否输出 ports 段(老 _first_port 也是返 "" 的语义)。
    return "", "no-signal"


def _detect_app_infra_deps(
    env_dict: dict[str, str],
    explicit_deps: list[str],
    wait_targets: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Per-app infra dep detection — pick the subset of wait_targets that
    THIS app actually references, instead of waiting for everything.

    `wait_targets` 包含**所有需要 TCP 探活的 infra**(schemaful DB +
    redis/mongodb/rabbitmq),不只是 schemaful DB。

    Bugbot fix(PR #521 第十一轮 Bug 1)— 之前 `_yaml_from_compose_services` 把
    全量 wait_targets 无脑套到每个 app(wait-for 命令 + depends_on),frontend
    只用 redis 也被注入 `until nc -z mysql 3306`,启动时白白等死掉的依赖。

    Detection sources (union):
      1. Explicit `depends_on` in this app's docker-compose entry
      2. Infra hostname appears in any of the app's env values
         (URL host / ADO.NET Server=name / `KEY=name` direct ref)

    Conservative fallback: if BOTH sources are empty (app has no env, no
    declared deps), include ALL targets — better over-wait than miss a
    real dep and crash on first DB query. This preserves the historic
    behavior for envless skeleton compose files while fixing the spam
    case where the app's env actually scopes its deps.
    """
    import re
    if not wait_targets:
        return []
    # Conservative fallback for projects with no env / no deps declared.
    if not env_dict and not explicit_deps:
        return list(wait_targets)

    deps: list[tuple[str, str]] = []
    explicit_set = set(explicit_deps)
    for tgt_name, tgt_port in wait_targets:
        if tgt_name in explicit_set:
            deps.append((tgt_name, tgt_port))
            continue
        # Match hostname as a token in env values:
        # - URL form:        mongodb://mongo:27017
        # - ADO.NET form:    Server=mysql,3306
        # - Direct host=name MYSQL_HOST=mysql
        # - Pure value:      mysql
        # Boundaries: start, [@/=,\s:], or end / [:,/;\s]
        host_re = re.compile(
            rf"(?:^|[@/=,\s:]){re.escape(tgt_name)}(?:[:,/;\s]|$)"
        )
        for v in env_dict.values():
            if host_re.search(str(v)):
                deps.append((tgt_name, tgt_port))
                break
    return deps


def _wrap_with_wait_for(command: str, infra_targets: list[tuple[str, str]]) -> str:
    """给 app command 前缀加 `until nc -z host port; do sleep 1; done && ...`。

    Phase 3 — 修 geo 实战根因 #2 的延伸:即使 Phase 2 兜底 deploy 起 infra,
    应用容器启动时 mongo / mysql 可能还没 ready 接受连接(初始化要 5-30s),
    应用一连就 crash。wait-for 用 `nc -z` 探活轮询直到 infra TCP 可达。

    幂等:如果原 command 里已经含 `nc -z` 或 `wait-for` 字样,不重复添加。

    infra_targets: list of (host, port) 二元组,如 [("mysql", "3306"), ("redis", "6379")]
    多个 infra 串行 wait,每个 1 秒间隔。

    设计取舍:为什么不用 `dockerize` / `wait-for-it.sh`?
    - 这俩都需要预装在镜像里(node/dotnet/python 镜像默认没有)
    - `nc` 在 alpine 里默认就有(busybox 自带),debian-slim 通过 `apt-get install -y netcat-openbsd` 自带
    - 直接用 sh 内置 `until ...` 语法,跨镜像兼容性最好
    """
    if not infra_targets:
        return command
    # 幂等:已含 wait 逻辑就不动
    if "nc -z" in command or "wait-for" in command or "dockerize" in command:
        return command
    waits = " && ".join(f"until nc -z {host} {port}; do sleep 1; done"
                        for host, port in infra_targets)
    # busybox nc 不支持 -z?其实支持。但 alpine 不带 netcat-openbsd,只有 busybox nc。
    # busybox nc 的 -z 行为是 connect-only(不发数据),我们要的就是这个。
    return f"{waits} && {command}"


# ── Phase 4(2026-05-01): ORM 识别 + migration 命令注入 ─────────────
#
# 北极星:让"任意 mysql/postgres/sqlserver 项目接 CDS"端到端跑通。Phase 1+2
# 修了 env 嵌套 + infra 自动起,Phase 3 修了 yaml 生成,但应用启动后第一件事
# 是 connect → query → "Table 'x.users' doesn't exist",**因为 schema 还没建**。
# Phase 4 自动检测项目用的 ORM,把 migration 命令前缀注入应用 command,让
# `<wait-for-db> && <migrate> && <原 command>` 一气呵成。

_ORM_TEMPLATES: list[dict] = [
    {
        "kind": "prisma",
        "label": "Prisma ORM",
        # 命中 prisma/schema.prisma 即认定 prisma 项目
        "detect_files": ["prisma/schema.prisma"],
        # detect_extra 用于二次确认,格式 (相对路径, 文件内必须含的子串)
        "detect_extra": [],
        # 注入到应用 command 启动前缀的 migration 命令
        "migrate_cmd": "npx prisma migrate deploy",
        # dev mode seed 命令(可选,目前没用到 — 给 Phase 4.3 dev/prod 模式用)
        "seed_cmd": "npx prisma db seed",
        # 用户文档链接,生成 yaml 注释里带上方便点击查
        "doc_url": "https://www.prisma.io/docs/orm/prisma-migrate",
    },
    {
        "kind": "ef-core",
        "label": "Entity Framework Core",
        # ef-core 不靠单一文件,靠 .csproj 含 Microsoft.EntityFrameworkCore 包引用
        "detect_files": [],
        "detect_glob": ["**/*.csproj"],
        "detect_extra": [("**/*.csproj", "Microsoft.EntityFrameworkCore")],
        # 必须先 dotnet tool restore(因为 dotnet-ef 是 global tool 需要 manifest)
        # 没 manifest 会失败 — Phase 4 的 verify 会提醒用户加 .config/dotnet-tools.json
        "migrate_cmd": "dotnet tool restore && dotnet ef database update",
        "seed_cmd": None,
        "doc_url": "https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/",
    },
    {
        "kind": "typeorm",
        "label": "TypeORM",
        "detect_files": ["package.json"],
        "detect_extra": [("package.json", "typeorm")],
        "migrate_cmd": "npm run migration:run",
        "seed_cmd": None,
        "doc_url": "https://typeorm.io/migrations",
    },
    {
        "kind": "sequelize",
        "label": "Sequelize",
        "detect_files": ["package.json"],
        "detect_extra": [("package.json", "sequelize-cli")],
        "migrate_cmd": "npx sequelize-cli db:migrate",
        "seed_cmd": "npx sequelize-cli db:seed:all",
        "doc_url": "https://sequelize.org/docs/v6/other-topics/migrations/",
    },
    {
        "kind": "rails",
        "label": "Rails ActiveRecord",
        "detect_files": ["Gemfile"],
        "detect_extra": [("Gemfile", "rails")],
        "migrate_cmd": "bundle exec rails db:migrate",
        "seed_cmd": "bundle exec rails db:seed",
        "doc_url": "https://guides.rubyonrails.org/active_record_migrations.html",
    },
    {
        "kind": "flyway",
        "label": "Flyway",
        # flyway 通常作 sidecar 容器单独跑;这里识别只是给个提示让用户知道
        # cdscli 暂不主动注入(flyway 是独立进程,不该塞进应用 command)
        "detect_files": ["flyway.conf"],
        "detect_extra": [],
        "migrate_cmd": None,  # 不注入,让用户单独跑 flyway 容器
        "seed_cmd": None,
        "doc_url": "https://flywaydb.org/documentation/command/migrate",
    },
]


def _detect_orm(app_dir: str) -> dict | None:
    """探测应用目录用的 ORM。返回 {kind, label, migrate_cmd, seed_cmd, ...} 或 None。

    探测顺序按 _ORM_TEMPLATES 数组顺序,第一个命中即返回(prisma > ef-core > typeorm
    > sequelize > rails > flyway)。同一项目混用多 ORM 罕见,真出现以靠前的为准。

    探测规则:
      1. detect_files 里所有文件都必须存在
      2. 如果有 detect_glob,glob 必须命中至少 1 个文件
      3. 如果有 detect_extra,对应文件必须含指定子串
      所有条件 AND 关系。
    """
    import glob
    import re

    for tpl in _ORM_TEMPLATES:
        ok = True

        # detect_files 全部存在
        for rel in tpl.get("detect_files", []):
            if not os.path.exists(os.path.join(app_dir, rel)):
                ok = False
                break
        if not ok:
            continue

        # detect_glob 命中
        glob_patterns = tpl.get("detect_glob", [])
        if glob_patterns:
            glob_hit = False
            for pattern in glob_patterns:
                # 支持 ** 递归
                matches = glob.glob(os.path.join(app_dir, pattern), recursive=True)
                if matches:
                    glob_hit = True
                    break
            if not glob_hit:
                ok = False
        if not ok:
            continue

        # detect_extra:对应文件含子串
        for rel_pattern, must_contain in tpl.get("detect_extra", []):
            # rel_pattern 可能是 glob(*.csproj),也可能是直接路径(package.json)
            candidates: list[str]
            if "*" in rel_pattern:
                candidates = glob.glob(os.path.join(app_dir, rel_pattern), recursive=True)
            else:
                full = os.path.join(app_dir, rel_pattern)
                candidates = [full] if os.path.exists(full) else []
            if not candidates:
                ok = False
                break
            # 任一候选文件含子串就算命中
            extra_hit = False
            for cand in candidates:
                try:
                    # Bugbot fix(PR #521 第九轮 Bug 4)— with-open 同上。
                    with open(cand, "r", encoding="utf-8", errors="ignore") as f:
                        text = f.read()
                    if must_contain in text:
                        extra_hit = True
                        break
                except Exception:
                    continue
            if not extra_hit:
                ok = False
                break
        if not ok:
            continue

        return tpl

    return None


def _wrap_with_migration(command: str, orm: dict | None) -> str:
    """在应用 command 前注入 ORM migration 命令。

    幂等:原 command 已含 migration 关键词(migrate / prisma / dotnet ef /
    sequelize-cli / rails db:migrate / flyway)就不重复添加,尊重用户写法。

    flyway 等 migrate_cmd=None 的 ORM 不注入(用户应单独跑 flyway 容器)。
    """
    if not orm or not orm.get("migrate_cmd"):
        return command
    cmd_lower = command.lower()
    # 幂等检查
    skip_keywords = ["prisma migrate", "dotnet ef", "sequelize-cli", "rails db:migrate",
                     "flyway migrate", "alembic upgrade", "migration:run",
                     "npm run migrate", "yarn migrate", "pnpm migrate", "bundle exec rake db:migrate"]
    if any(kw in cmd_lower for kw in skip_keywords):
        return command
    return f"{orm['migrate_cmd']} && {command}"


def _yaml_from_compose_services(root: str, services: dict) -> "tuple[str, dict]":
    """把 docker-compose services 转成 cds-compose 格式。

    基础设施识别(2026-05-01 增强):
      - 命中 _INFRA_TEMPLATES 的 image → 用模板渲染完整 service 段(image
        统一替换为推荐 stable image,自动加初始化 env 引用 ${VAR})
      - 同时把账号密码 + 应用侧连接串写入 x-cds-env(随机生成密码,加注释)
      - 应用侧通过 ${MONGODB_URL} / ${DATABASE_URL} 等读取连接串,与容器
        side 共享同一字符串 — Railway 心智:同名变量两边自动通

    无模板的 image 走原"裸抄"路径,只把 image+ports 抄过来,加 TODO 注释。
    """
    import re  # 给后面 host_rewrite 的 re.compile / re.escape 用
    project_name = os.path.basename(root)
    # 先扫一遍服务,收集需要的 infra 模板 + 渲染信号
    infra_renders: list[dict] = []  # 命中模板的 infra:{name, template, original_image}
    raw_infras: list[str] = []  # 是 infra 但没匹配到模板,走兜底
    app_names: list[str] = []
    # Phase 4:每个应用 service 的 ORM 检测结果(给 signals.orms 用)
    detected_orms_for_signal: dict[str, str] = {}  # service_name → orm_kind
    # Phase 4.3:dev/prod 模式 — 收集每个 app 的 dev mode command(带 seed)
    # 在 services 渲染完后输出 x-cds-deploy-modes 段
    # 格式:{app_name: dev_command_with_seed}
    dev_mode_commands: dict[str, str] = {}

    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        image = svc.get("image", "")
        tpl = _find_infra_template(image)
        if tpl is not None:
            # Phase 3:同时记录 original_svc(给 volumes carry-over 用)
            # Phase 7 fix(B13,2026-05-01):name 用用户原 service 名(不是
            # 模板默认名),否则其它 service 内的 ${PG_DATABASE_HOST:-db} /
            # depends_on: [db] 等引用会断。"用户写 db 我们就保留 db,
            # 用户写 mongo 我们就保留 mongo"。
            infra_renders.append({
                "name": name,                          # ← B13:用 svc 在 docker-compose 里的真实 name
                "template_name": tpl["name"],          # 模板分类用(给 wait_targets 等)
                "template": tpl,
                "original_image": image,
                "original_svc": svc,
            })
        elif _is_infra_image(image):  # 历史 _is_infra_image 现在与 _find_infra_template 等价,保留保险
            raw_infras.append(name)
        else:
            app_names.append(name)

    # 收集 x-cds-env 顶层键(去重,后到的覆盖)
    global_env_decls: dict[str, tuple] = {}  # key → (value, is_password, comment)
    env_meta: dict[str, dict] = {}  # Phase 8:key → {kind, hint}
    for r in infra_renders:
        # Bugbot fix(PR #521 第七轮)— Phase 7 B13 修复了"不 rename infra service
        # 名"(保留用户的 `db`,不强行改成 `postgres`),但连接串模板里 hostname
        # 还硬编码 template 默认名(如 `@postgres:5432` / `@mysql:3306` /
        # `Server=sqlserver,1433` 等)。container.ts 用 `service.id`(用户 `db`)
        # 给 docker --network-alias,所以 DNS 只解析 `db` 而不是 `postgres` →
        # 应用拿到 CDS_DATABASE_URL 指向不存在的 hostname,连接失败。
        #
        # 修法:把 template global_env value 里硬编码的 template 默认 hostname
        # 替换成用户实际 service name。用 \b<host>(?=[:,]\d) 模式 — 匹配
        # `<host>:<port>` 或 ADO.NET 的 `<host>,<port>`,排除 URL scheme
        # `mongodb://`(scheme 后是 `/`,不是 digit,不被替换)
        actual_host = r["name"]
        template_host = r["template_name"]
        host_rewrite = None
        if actual_host != template_host:
            host_rewrite = re.compile(
                rf"\b{re.escape(template_host)}(?=[:,]\d)"
            )

        for entry in r["template"]["global_env"]:
            key, default, is_password, comment = entry
            value = _gen_password() if is_password and default is None else default
            # 替换模板默认 hostname → 用户实际 service name
            if host_rewrite and value:
                value = host_rewrite.sub(actual_host, value)
            global_env_decls[key] = (value, is_password, comment)
            kind, hint = _classify_env_kind(key, default, is_password)
            env_meta[key] = {"kind": kind, "hint": hint or comment}

    # 通用 env(应用通用 - 仅注入"几乎所有项目都需要的"项)
    #
    # Bugbot fix(PR #521 第五轮)— 删除 AI_ACCESS_KEY 默认注入。
    # 之前在 common_env 强制注入 AI_ACCESS_KEY="TODO: 请填写实际值",
    # 配合 Phase 8.3 deploy 412 block + 第四轮的 TODO 占位符判定,
    # 导致每个项目(即使根本不用 AI)都被 block 必须先填 AI_ACCESS_KEY。
    # 修法:不默认注入,改由 _collect_required_envs_from_app_services 路径
    # 在用户 docker-compose 真的引用了 ${AI_ACCESS_KEY} 时才识别注入,
    # 跟 SMTP_PASSWORD / OAUTH_SECRET 等"用户必填项"处理方式统一。
    common_env = [
        ("CDS_JWT_SECRET", _gen_password(), True, "JWT 签名密钥(CDS 自动随机生成,改了所有 token 失效)"),
    ]
    for key, value, is_pwd, comment in common_env:
        if global_env_decls.setdefault(key, (value, is_pwd, comment)) == (value, is_pwd, comment):
            kind, hint = _classify_env_kind(key, value if not is_pwd else None, is_pwd)
            env_meta.setdefault(key, {"kind": kind, "hint": hint or comment})

    # Phase 8:扫描 app services 的 environment,把引用的 ${VAR} 但 cdscli 没生成的
    # 变量补到 global_env_decls,让 CDS 弹窗强制用户填(密钥类才 block)。
    #
    # Bugbot fix(PR #521 第十三轮 Bug 2)— 走 _classify_env_kind,**尊重 fallback**:
    # `${LOG_LEVEL:-info}` 类有非空默认值的变量自动归 auto,不再被错误标 required
    # 在 UI 上 block 用户。`${EMAIL_PASSWORD}` 类无 fallback + 命中 secret 关键词
    # 才标 required。统一与 _classify_env_kind 的 SSOT 判定。
    user_required_vars = _collect_required_envs_from_app_services(
        services, app_names, set(global_env_decls.keys())
    )
    for var, fallback_value in user_required_vars.items():
        kind, hint = _classify_env_kind(var, fallback_value or None, is_password=False)
        global_env_decls[var] = (
            fallback_value or "",
            False,
            f"应用引用:{var}" + (f"(默认 {fallback_value})" if fallback_value else ""),
        )
        env_meta[var] = {"kind": kind, "hint": hint}

    lines: list[str] = [
        "# CDS Compose 配置 — 由 cdscli scan 从 docker-compose 自动生成",
        "# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴",
        "",
        "x-cds-project:",
        f"  name: {project_name}",
        f"  description: \"{project_name} 全栈项目\"",
        "",
        "# 项目级环境变量(本项目独占 — 不会跨项目泄漏 / 污染其它项目)",
        "# CDS 把这里的变量注入到本项目的所有容器(基础设施 + 应用),通过",
        "# ${VAR_NAME} 引用,让基础设施容器和应用容器共享同一连接字符串",
        "# 密码字段由 cdscli 自动随机生成,可在此处直接修改",
        "x-cds-env:",
    ]
    for key, (value, is_password, comment) in global_env_decls.items():
        lines.append(f"  # {comment}")
        # 字符串值用双引号包,避免 yaml 把数字/特殊字符误解析
        safe = (value or "").replace("\\", "\\\\").replace("\"", "\\\"")
        lines.append(f"  {key}: \"{safe}\"")

    # Phase 8:env 三色 metadata — CDS 后端读这一段决定哪些必填 / 哪些自动 / 哪些推导
    # 用户导入项目后 CDS UI 弹窗:上面 required(必填)/ 下面 auto + infra-derived(CDS 搞定)
    if env_meta:
        lines.append("")
        lines.append("# 环境变量元信息 — CDS 据此弹窗强制用户填 required,auto/infra-derived 跑自动")
        lines.append("x-cds-env-meta:")
        for key, meta in env_meta.items():
            kind = meta.get("kind", "auto")
            hint = (meta.get("hint") or "").replace("\\", "\\\\").replace("\"", "\\\"")
            lines.append(f"  {key}:")
            lines.append(f"    kind: {kind}")
            if hint:
                lines.append(f"    hint: \"{hint}\"")

    lines.append("")
    lines.append("services:")

    # ── 渲染基础设施(用模板)──
    for r in infra_renders:
        name = r["name"]
        tpl = r["template"]
        original_svc = r.get("original_svc") or {}
        lines.append(f"  {name}:")
        lines.append(f"    image: {tpl['image']}")
        lines.append(f"    ports:")
        lines.append(f"      - \"{tpl['container_port']}\"")
        if tpl["service_env"]:
            lines.append(f"    environment:")
            for k, v in tpl["service_env"].items():
                lines.append(f"      {k}: \"{v}\"")
        if tpl.get("service_command"):
            lines.append(f"    command: {tpl['service_command']}")
        # Phase 3:carry over 用户原 docker-compose 的 volumes 段(尤其 init.sql)
        # 重要:挂 init.sql 到 /docker-entrypoint-initdb.d/ 是 schemaful DB 的关键
        # 初始化路径,必须保留。命名 volume(mysql_data:/var/lib/mysql)也保留,
        # 避免每次重建容器都重置数据。
        original_volumes = original_svc.get("volumes") or []
        if isinstance(original_volumes, list) and original_volumes:
            lines.append(f"    volumes:")
            for v in original_volumes:
                if isinstance(v, str):
                    lines.append(f"      - \"{v}\"")
                elif isinstance(v, dict) and v.get("source") and v.get("target"):
                    # docker-compose 长格式:{source, target, type, read_only}
                    src = v["source"]; dst = v["target"]
                    suffix = ":ro" if v.get("read_only") else ""
                    lines.append(f"      - \"{src}:{dst}{suffix}\"")
            # 提示:init.sql 修改后必须重置 data volume,否则不会重新执行
            init_path = tpl.get("init_sql_path") or ""
            if init_path and any(init_path in str(v) for v in original_volumes):
                lines.append(f"    # ⚠ init.sql 已挂到 {init_path}")
                lines.append(f"    #   修改后必须重置 data volume(否则不会重新执行):")
                lines.append(f"    #   docker volume rm <项目>_<volume-name> 后再 deploy")
        lines.append(f"    # 来源 docker-compose 的 {r['original_image']!r},已切换为 cdscli 推荐 image")

    # ── 渲染未识别的 infra(裸抄,加 TODO)──
    for name in raw_infras:
        svc = services[name]
        image = svc.get("image", "")
        port = _first_port(svc.get("ports") or [])
        lines.append(f"  {name}:")
        lines.append(f"    image: {image}")
        if port:
            lines.append(f"    ports:")
            lines.append(f"      - \"{port}\"")
        lines.append(f"    # TODO: 未在 cdscli 模板表中,需手动确认账号密码/连接串")

    # 已识别的 infra **模板** 名字集合(给 app env 连接串重写用 — 检查项目"是否有"
    # 这类 infra,与 service 实际叫什么名字无关)。**用 template_name(分类),不是
    # service name**。
    present_infra_names: set[str] = {r["template_name"] for r in infra_renders}

    # Phase 3 + Phase 7 fix(B13):收集"需要应用 wait-for 的 infra"的 (host, port) —
    # 给 app command 的 wait-for 前缀用 nc -z <host> <port>。host **必须是实际
    # service 名**(用户原 yaml 里写啥就用啥,docker network DNS 走 service 名),
    # 不是模板名。
    #
    # Bugbot fix(PR #521 第十四轮 Bug 2)— 重命名 schemaful_targets → wait_targets。
    # 之前命名只反映"schemaful DB(mysql/postgres/sqlserver)",但实际还塞了
    # 非 schemaful 的 redis / mongodb / rabbitmq,变量名跟内容不符,后续维护者
    # 改 _detect_app_infra_deps 容易误以为只处理 DB。新名 wait_targets 直观对应
    # "所有需要 TCP 探活的 infra"。
    wait_targets: list[tuple[str, str]] = [
        (r["name"], r["template"]["container_port"])
        for r in infra_renders if r["template"].get("schemaful")
    ]
    # 非 schemaful 但需要 wait 的 infra(redis / mongo / rabbitmq):也加上,提高鲁棒性
    for r in infra_renders:
        if r["template"].get("schemaful"):
            continue
        if r["template_name"] in ("redis", "mongodb", "rabbitmq"):
            wait_targets.append((r["name"], r["template"]["container_port"]))

    # ── 渲染应用 service ──
    for name in app_names:
        svc = services[name]
        # Phase 3:用 _detect_app_port 取代 _first_port,自动检测 webpack/.NET 真实端口
        port, port_source = _detect_app_port(svc, root)
        build = svc.get("build")
        lines.append(f"  {name}:")
        if isinstance(build, dict):
            ctx = build.get("context", ".")
            df = build.get("dockerfile")
            lines.append(f"    build:")
            lines.append(f"      context: {ctx}")
            if df:
                lines.append(f"      dockerfile: {df}")
        elif isinstance(build, str) and build:
            # docker-compose 简写形式:`build: ./api` 直接是 context 路径
            lines.append(f"    build:")
            lines.append(f"      context: {build}")
        elif svc.get("image"):
            lines.append(f"    image: {svc['image']}")
        if port:
            lines.append(f"    ports:")
            lines.append(f"      - \"{port}\"  # 端口推断来源: {port_source}")

        # Phase 3:carry over working_dir(CDS BuildProfile 需要 containerWorkDir,
        # 默认 /app,但用户 docker-compose 可能用别的路径)
        wd = svc.get("working_dir")
        if wd:
            lines.append(f"    working_dir: {wd}")

        # Phase 3:carry over volumes(★ 关键:相对路径 mount ./xxx:/app 是 CDS
        # 识别"应用 service"的硬性要求 — compose-parser.ts 的 hasRelativeVolumeMount
        # 走这一项判定。漏掉的话 CDS 会把它当成 infra,完全跑不起来)
        original_volumes = svc.get("volumes") or []
        if isinstance(original_volumes, list) and original_volumes:
            lines.append(f"    volumes:")
            for v in original_volumes:
                if isinstance(v, str):
                    lines.append(f"      - \"{v}\"")
                elif isinstance(v, dict) and v.get("source") and v.get("target"):
                    src = v["source"]; dst = v["target"]
                    suffix = ":ro" if v.get("read_only") else ""
                    lines.append(f"      - \"{src}:{dst}{suffix}\"")
        else:
            # 应用 service 没有任何 volume → CDS 会把它当 infra
            # 如果有 build 就推断 context 当源码 mount,否则挂当前目录
            ctx = "."
            if isinstance(build, dict):
                ctx = build.get("context", ".")
            elif isinstance(build, str) and build:
                ctx = build
            if ctx and ctx != ".":
                ctx_clean = ctx if ctx.startswith("./") else f"./{ctx}"
            else:
                ctx_clean = "."
            wd_clean = wd or "/app"
            lines.append(f"    volumes:")
            lines.append(f"      - \"{ctx_clean}:{wd_clean}\"  # 自动推断:CDS 必须有相对 mount 才识别为应用")

        # Phase 4:ORM 探测 — 从应用源码目录(同 _detect_app_port 的 src_dirs 逻辑)
        # 找 prisma/ef-core/typeorm/sequelize/rails/flyway,命中就把 migration
        # 命令注入 command 前缀。链:<wait-for> && <migrate> && <原 command>
        app_src_dirs: list[str] = []
        if isinstance(build, dict):
            app_src_dirs.append(os.path.join(root, _strip_dot_slash(build.get("context", "."))))
        elif isinstance(build, str) and build:
            app_src_dirs.append(os.path.join(root, _strip_dot_slash(build)))
        for v in svc.get("volumes") or []:
            if isinstance(v, str):
                host = v.split(":")[0]
                if host.startswith("./") or host == ".":
                    app_src_dirs.append(os.path.join(root, _strip_dot_slash(host) or "."))
        if not app_src_dirs:
            app_src_dirs.append(root)
        detected_orm: dict | None = None
        for d in app_src_dirs:
            if os.path.isdir(d):
                detected_orm = _detect_orm(d)
                if detected_orm:
                    detected_orms_for_signal[name] = detected_orm["kind"]
                    break

        # carry over 原 environment 段(提前到 wait-for 之前,给 _detect_app_infra_deps 喂数据)
        # docker-compose 的 environment 可能是 dict 也可能是 list 形式,两种都处理
        env_section = svc.get("environment")
        env_dict: dict[str, str] = {}
        if isinstance(env_section, dict):
            for k, v in env_section.items():
                env_dict[str(k)] = str(v) if v is not None else ""
        elif isinstance(env_section, list):
            # list 形式:["KEY=VAL", "KEY2=VAL2"]
            for item in env_section:
                if isinstance(item, str) and "=" in item:
                    k, _, v = item.partition("=")
                    env_dict[k.strip()] = v.strip()

        # Phase 3:carry over depends_on(便于自文档化,Phase 2 兜底也尊重显式声明)
        deps_raw = svc.get("depends_on") or []
        deps: list[str] = []
        if isinstance(deps_raw, dict):
            deps = list(deps_raw.keys())
        elif isinstance(deps_raw, list):
            deps = [str(d) for d in deps_raw if isinstance(d, str)]

        # Bugbot fix(PR #521 第十一轮 Bug 1)— 只对该 app **真实引用**的 infra
        # 加 wait-for 和 depends_on,而不是对所有 wait_targets 一刀切。
        # frontend 只用 redis 不会再被注入 `until nc -z mysql 3306`。
        relevant_targets = _detect_app_infra_deps(env_dict, deps, wait_targets)

        # Phase 3:carry over command,命中 schemaful DB 时加 wait-for 前缀
        # Phase 4:再叠加 ORM migration 前缀(顺序:wait-for → migrate → 原 command)
        original_cmd = svc.get("command")
        if isinstance(original_cmd, list):
            original_cmd = " ".join(str(c) for c in original_cmd)
        if original_cmd:
            with_migration = _wrap_with_migration(original_cmd, detected_orm)
            wrapped = _wrap_with_wait_for(with_migration, relevant_targets)
            # 如果 command 含 shell 元字符($,&&,|),用 bash -c 包起来确保跑得了
            if any(ch in wrapped for ch in ("&&", "||", ";", "$(", "`")):
                # YAML 双引号字符串里 \" 转义就够;wrapped 里如果已含 " 也要转
                safe = wrapped.replace("\\", "\\\\").replace("\"", "\\\"")
                # Phase 6 fix(2026-05-01,B9):用 sh -c 不是 bash -c,因为很多
                # 应用镜像(alpine 全家)只有 sh 没 bash。POSIX sh 支持 until/&&,够用。
                lines.append(f"    command: sh -c \"{safe}\"")
            else:
                lines.append(f"    command: {wrapped}")
            if relevant_targets and "nc -z" in wrapped:
                target_list = ",".join(t[0] for t in relevant_targets)
                lines.append(f"    # wait-for 前缀:启动前先 TCP 探活 {target_list}(防 Phase 2 兜底起 infra 后应用抢跑)")
            if detected_orm and detected_orm.get("migrate_cmd") and detected_orm["migrate_cmd"] in wrapped:
                lines.append(f"    # migration 前缀({detected_orm['label']}):{detected_orm['migrate_cmd']}")
                lines.append(f"    # ↳ 文档: {detected_orm['doc_url']}")

            # Phase 4.3:dev mode 命令(带 seed,如果 ORM 支持)
            # 默认 base command 是 prod 友好(无 seed,不污染数据库),
            # dev mode 通过 x-cds-deploy-modes 提供 seed 选项,用户在 CDS UI 切
            if detected_orm and detected_orm.get("seed_cmd"):
                # 在 migration 之后、原 command 之前插 seed
                base = original_cmd
                with_migrate_seed = f"{detected_orm['migrate_cmd']} && {detected_orm['seed_cmd']} && {base}"
                dev_cmd = _wrap_with_wait_for(with_migrate_seed, relevant_targets)
                dev_mode_commands[name] = dev_cmd
        else:
            # Bugbot fix(PR #521 第十二轮 Bug 3)— 没声明 command 但需要
            # wait-for / migrate 注入时,镜像默认 CMD 不可见,无法安全前缀。
            # 为避免静默失败(应用抢跑炸 Connection refused / table doesn't exist),
            # 在 YAML 输出加显眼警告 + stderr 提醒,引导用户显式声明 command。
            needs_wait = bool(relevant_targets)
            needs_migrate = bool(detected_orm and detected_orm.get("migrate_cmd"))
            if needs_wait or needs_migrate:
                lines.append(f"    # ⚠ 该 service 未声明 command,使用镜像默认 CMD,cdscli 无法注入 wait-for / migration 前缀。")
                if needs_wait:
                    target_list = ",".join(t[0] for t in relevant_targets)
                    lines.append(f"    # ⚠ 检测到依赖 schemaful infra({target_list}):未 wait 启动可能 Connection refused。")
                if needs_migrate:
                    lines.append(f"    # ⚠ 检测到 ORM({detected_orm['label']})migration:{detected_orm['migrate_cmd']}")
                    lines.append(f"    # ⚠ 不跑 migration 会启动后报 'table doesn\\'t exist'。")
                lines.append(f"    # ⚠ 修复:在 docker-compose 显式写 command,cdscli 会自动包装。")
                # stderr 同步告警,scan 输出可见
                print(
                    f"[scan] WARN: service '{name}' 未声明 command,无法注入 "
                    f"{'wait-for' if needs_wait else ''}{'+migrate' if needs_wait and needs_migrate else 'migrate' if needs_migrate else ''}"
                    f" 前缀;请在 docker-compose 显式 command,YAML 已加警告注释。",
                    file=sys.stderr,
                )

        if env_dict:
            lines.append(f"    environment:")
            for k, v in env_dict.items():
                rewritten = _rewrite_env_value_with_infra_aliases(v, present_infra_names)
                # yaml 字符串值用双引号包,防止 ${} 被误解析
                safe = rewritten.replace("\\", "\\\\").replace("\"", "\\\"")
                lines.append(f"      {k}: \"{safe}\"")

        # 如果 relevant_targets 有但 deps 没声明,自动补(Layer 1 显式声明优先)
        for tgt_name, _ in relevant_targets:
            if tgt_name not in deps:
                deps.append(tgt_name)
        if deps:
            lines.append(f"    depends_on:")
            for d in deps:
                lines.append(f"      - {d}")

        # 第一个 app 服务挂 / 路径,其它给 TODO
        if name == app_names[0]:
            lines.append(f"    labels:")
            lines.append(f"      cds.path-prefix: \"/\"")
        else:
            lines.append(f"    labels:")
            lines.append(f"      # TODO: 调整为实际路径前缀")
            lines.append(f"      cds.path-prefix: \"/{name}/\"")

    # Phase 4.3:渲染 x-cds-deploy-modes,给有 seed 能力的 ORM 暴露 dev mode 选项
    # 默认 base command 是 prod 友好(无 seed),用户在 CDS UI 切到 dev mode 才跑 seed
    if dev_mode_commands:
        lines.append("")
        lines.append("# 部署模式 — 默认 command 是 prod(只 migrate),dev 模式额外跑 seed")
        lines.append("# 用户在 CDS UI 的「构建配置 → 部署模式」可切换")
        lines.append("x-cds-deploy-modes:")
        for svc_name, dev_cmd in dev_mode_commands.items():
            lines.append(f"  {svc_name}:")
            lines.append(f"    dev:")
            lines.append(f"      label: \"Dev(含 seed 数据库种子)\"")
            # Phase 6 fix(2026-05-01,B9):同样改 sh -c(alpine 兼容)
            safe_dev = dev_cmd.replace("\\", "\\\\").replace("\"", "\\\"")
            lines.append(f"      command: sh -c \"{safe_dev}\"")
            lines.append(f"    prod:")
            lines.append(f"      label: \"Prod(只 migrate,不 seed,不污染数据库)\"")
            lines.append(f"      # 即默认 services.{svc_name}.command,留空表示走默认")

    yaml_output = "\n".join(lines) + "\n"
    # Phase 4:把 ORM 检测结果作为额外 signals 返回。返回 (yaml, extras_dict)
    # 二元组,cmd_scan 用 extras 填充 signals.orms。
    extras = {
        "orms": detected_orms_for_signal,  # {"backend": "prisma", ...}
        # Phase 7 fix(B13):用 service 实际 name(用户原 yaml 写的),不是模板默认名
        "schemafulInfra": [r["name"] for r in infra_renders if r["template"].get("schemaful")],
        "deployModes": list(dev_mode_commands.keys()),  # 哪些 service 提供了 dev/prod 切换
    }
    return yaml_output, extras


def _first_port(ports: list) -> str:
    """从 docker-compose ports 列表里取第一个 host port。'5500:80' → '80'。"""
    if not ports:
        return ""
    p = str(ports[0])
    if ":" in p:
        # host:container,取 container 端口
        return p.split(":")[-1]
    return p


def _parse_maven_modules(pom_path: str) -> list[str]:
    """从 Maven parent pom 解析 <modules><module>X</module></modules>。"""
    import re
    try:
        with open(pom_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        m = re.search(r"<modules>(.*?)</modules>", content, re.DOTALL)
        if not m:
            return []
        return re.findall(r"<module>\s*([^<\s]+)\s*</module>", m.group(1))
    except Exception:
        return []


def _read_java_version_from_pom(pom_path: str) -> str | None:
    """从 pom.xml 解析 Java 版本号。

    优先级:<java.version> > <maven.compiler.source> > <maven.compiler.target>
    返回简化版本(如 "8"、"11"、"17"、"21");未识别返回 None。

    Issue #561 / #550:myTapd 等 Java 8 项目被错误标为 JDK 17 镜像,
    导致 CDS 部署后跑不起来。这里读 pom 里的真实版本。
    """
    import re
    try:
        with open(pom_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception:
        return None
    for tag in ("java.version", "maven.compiler.source",
                "maven.compiler.target", "maven.compiler.release"):
        m = re.search(rf"<{re.escape(tag)}>\s*([^<\s]+)\s*</{re.escape(tag)}>", content)
        if not m:
            continue
        raw = m.group(1).strip()
        # 处理 "1.8" → "8"、"1.7" → "7"
        if raw.startswith("1.") and len(raw) > 2 and raw[2:].isdigit():
            return raw[2:]
        # 处理 "${java.version}" 这类占位符,跳过
        if raw.startswith("${"):
            continue
        # 处理 "8"、"11"、"17"、"21"
        if raw.isdigit():
            return raw
    return None


def _read_java_version_from_parent(parent_pom_path: str, child_pom_path: str) -> str | None:
    """先读 child,再回退 parent。Maven 项目大多在 parent 里声明 java.version。"""
    return _read_java_version_from_pom(child_pom_path) \
        or _read_java_version_from_pom(parent_pom_path)


def _maven_image_for_java(version: str | None) -> str:
    """根据 Java 版本号选 Maven base image。

    Java 8 → eclipse-temurin-8(项目实测 myTapd 必需)
    Java 11 → eclipse-temurin-11
    Java 17 → eclipse-temurin-17(默认)
    Java 21 → eclipse-temurin-21
    其它 / 未识别 → eclipse-temurin-17
    """
    if not version:
        return "maven:3.9.9-eclipse-temurin-17"
    v = version.strip()
    if v in ("7", "8", "11", "17", "21"):
        return f"maven:3.9.9-eclipse-temurin-{v}"
    return "maven:3.9.9-eclipse-temurin-17"


def _read_spring_port(module_path: str) -> str | None:
    """从 application.yml / bootstrap.yml / application.properties 读 server.port。

    扫描顺序:bootstrap.yml > application.yml > application-dev.yml > application.properties
    其中 src/main/resources 下的文件优先级最高。
    Issue #550:miduo-admin 实际端口是 9186,不是默认 8080。
    """
    import re
    candidates = [
        "src/main/resources/bootstrap.yml",
        "src/main/resources/bootstrap.yaml",
        "src/main/resources/application.yml",
        "src/main/resources/application.yaml",
        "src/main/resources/application-dev.yml",
        "src/main/resources/application-dev.yaml",
        "src/main/resources/application.properties",
        "bootstrap.yml",
        "application.yml",
    ]
    for rel in candidates:
        path = os.path.join(module_path, rel)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except Exception:
            continue
        # YAML 形式:server:\n  port: 9186
        m = re.search(r"(?ms)^server:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+port:\s*([0-9]{2,5})\b", text)
        if m:
            validated = _normalize_port(m.group(1))
            if validated:
                return validated
        # properties 形式:server.port=9186
        m = re.search(r"(?m)^\s*server\.port\s*=\s*([0-9]{2,5})\b", text)
        if m:
            validated = _normalize_port(m.group(1))
            if validated:
                return validated
    return None


def _detect_spring_runtime_deps(module_path: str) -> dict:
    """扫描 application*.yml/properties 推断后端运行时依赖(MySQL/Redis/MinIO/RabbitMQ)。

    返回 {"mysql": True, "redis": True, ...},仅做线索探测,不展开 infra。
    Issue #561:myTapd 后端依赖 MySQL/Redis/MinIO,scan 应该至少在 signals 里告警。
    """
    deps = {"mysql": False, "redis": False, "minio": False,
            "rabbitmq": False, "mongodb": False, "postgres": False,
            "nacos": False}
    candidates = []
    # 同时扫子模块的 src/main/resources(parent pom 场景:bootstrap 在主模块)
    for d in (module_path, *(os.path.join(module_path, sub)
                              for sub in os.listdir(module_path)
                              if os.path.isdir(os.path.join(module_path, sub)))) \
            if os.path.isdir(module_path) else (module_path,):
        res_dir = os.path.join(d, "src", "main", "resources")
        if os.path.isdir(res_dir):
            try:
                for name in os.listdir(res_dir):
                    if name.startswith(("application", "bootstrap")) and \
                            name.endswith((".yml", ".yaml", ".properties")):
                        candidates.append(os.path.join(res_dir, name))
            except Exception:
                pass
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read().lower()
        except Exception:
            continue
        if "jdbc:mysql" in text or "datasource" in text and "mysql" in text:
            deps["mysql"] = True
        if "jdbc:postgres" in text or "postgresql" in text:
            deps["postgres"] = True
        if "redis:" in text or "spring.redis" in text or "spring.data.redis" in text:
            deps["redis"] = True
        # Issue #566 缺陷 #8 / #566 缺陷 #12:minio 关键字识别强化
        # 老逻辑漏识 myTapd application-dev.yml 中典型 `minio:` block(顶级 + 缩进 endpoint/access-key/secret-key/bucket)
        # 现在覆盖:
        #   - 字面包含 "minio"
        #   - "s3-endpoint" / "s3.endpoint" / "s3:" 段
        #   - 七牛云 (qiniu) endpoint
        #   - bucket + (access-key|accesskey) 同时出现(典型对象存储签名)
        #   - endpoint:.*:9000 / endpoint:.*minio
        if (
            "minio" in text
            or "s3-endpoint" in text or "s3.endpoint" in text
            or ("qiniu" in text and "endpoint" in text)
            or ("bucket" in text and ("access-key" in text or "accesskey" in text or "access_key" in text))
            or "endpoint: http" in text and ":9000" in text
        ):
            deps["minio"] = True
        if "rabbitmq" in text or "spring.rabbitmq" in text or "amqp:" in text:
            deps["rabbitmq"] = True
        if "mongodb" in text or "spring.data.mongodb" in text:
            deps["mongodb"] = True
        # Issue #566 缺陷 #8:nacos config / discovery
        if "nacos" in text and ("server-addr" in text or "namespace" in text
                                or "config" in text or "discovery" in text):
            deps["nacos"] = True
    return deps


def _detect_spring_run_args(module_path: str, parent_path: str | None = None,
                            root_path: str | None = None) -> dict:
    """扫描项目文档(AGENTS.md/README.md)和 yml 推断 Spring Boot 启动参数。

    返回 {"profile": "dev", "needsTls12": True} 等。
    Issue #561:myTapd 必须 -Dspring-boot.run.profiles=dev -Djdk.tls.client.protocols=TLSv1.2。
    Issue #566 缺陷 #7:必须扫仓库根 AGENTS.md(myTapd 的 TLS 提示只在 /AGENTS.md)。
    """
    args = {"profile": None, "needsTls12": False}
    docs = []
    seen: set[str] = set()
    for parent in (module_path, parent_path, root_path):
        if not parent:
            continue
        for name in ("AGENTS.md", "README.md", "README.markdown",
                     "readme.md", "Readme.md",
                     "doc/README.md", "docs/README.md"):
            path = os.path.join(parent, name)
            real = os.path.realpath(path)
            if real in seen:
                continue
            if os.path.exists(path):
                docs.append(path)
                seen.add(real)
    for path in docs:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except Exception:
            continue
        import re
        # spring-boot.run.profiles=dev
        m = re.search(r"spring-boot\.run\.profiles[=\s]+([a-z][a-zA-Z0-9_-]*)", text)
        if m and not args["profile"]:
            args["profile"] = m.group(1)
        # TLSv1.2 / jdk.tls.client.protocols
        if "jdk.tls.client.protocols" in text or "TLSv1.2" in text:
            args["needsTls12"] = True
    return args


def _detect_vite_api_env_keys(sub_path: str) -> list[str]:
    """扫描 Vite 前端项目源码,抽出 import.meta.env.VITE_*_API_* 风格的 env key 引用。

    Issue #560:imp-admin 等前端引用 VITE_API_BASE_URL / VITE_PARTNER_API_BASE_URL,
    若 compose 不注入,部署后浏览器 API 调用全 404。
    返回 ["VITE_API_BASE_URL", "VITE_PARTNER_API_BASE_URL"] 这样的列表。
    """
    import re
    found: set[str] = set()
    src_roots = [os.path.join(sub_path, "src")]
    if not os.path.isdir(src_roots[0]):
        src_roots = [sub_path]
    for root_dir in src_roots:
        if not os.path.isdir(root_dir):
            continue
        # 扫描深度限制 4 层,避免巨型 monorepo
        for cur, dirs, files in os.walk(root_dir):
            depth = cur[len(root_dir):].count(os.sep)
            if depth > 4:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in
                       ("node_modules", "dist", "build", ".turbo", ".next")]
            for fname in files:
                if not fname.endswith((".ts", ".tsx", ".js", ".jsx",
                                       ".vue", ".svelte", ".env",
                                       ".env.development", ".env.production")):
                    continue
                fpath = os.path.join(cur, fname)
                try:
                    if os.path.getsize(fpath) > 512 * 1024:
                        continue  # 跳过超大文件
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        text = f.read()
                except Exception:
                    continue
                # import.meta.env.VITE_API_BASE_URL / process.env.VITE_*
                for m in re.finditer(r"\b(VITE_[A-Z][A-Z0-9_]*?(?:API|URL|BASE|HOST|ENDPOINT)[A-Z0-9_]*)\b", text):
                    found.add(m.group(1))
    return sorted(found)


def _expand_maven_parent(parent_path: str, parent_dir: str, pom_path: str,
                         root_path: str | None = None) -> list[dict]:
    """从 Maven parent pom 展开 Spring Boot 子模块，每个可运行模块生成一个服务。

    volume 挂 parent 根目录（./parent:/app），command 用 -pl <module> -am，
    这样 sibling modules（如 imp-domain）能被 Maven reactor 正确解析。
    纯库模块（无 spring-boot-maven-plugin）会被跳过，不生成服务。
    Issue #566 缺陷 #7:把 root_path 透传下去,让 _detect_spring_run_args 能扫仓库根 AGENTS.md。
    """
    children = []
    parent_java_version = _read_java_version_from_pom(pom_path)
    parent_run_args = _detect_spring_run_args(parent_path, None, root_path)
    # 父模块也扫一次 runtime deps,把 imp-platform/docker-compose 旁边的 yml 信号拿到
    parent_runtime_deps = _detect_spring_runtime_deps(parent_path)
    # v0.6.7 Bug S: 兄弟模块列表,渲染 spring-boot:run 命令时用 `-pl A,B,-runModule`
    # 反向选择(install 所有 sibling,跑目标 module),避免 multi-module 父 install 失败
    sibling_modules = _parse_maven_modules(pom_path)
    for module_name in sibling_modules:
        child_path = os.path.join(parent_path, module_name)
        child_pom = os.path.join(child_path, "pom.xml")
        if not os.path.exists(child_pom):
            continue
        if _is_maven_parent_pom(child_pom):
            continue  # 嵌套 parent，跳过
        if not _is_spring_boot_pom(child_pom):
            continue  # 纯库模块，不是可运行服务
        java_version = _read_java_version_from_pom(child_pom) or parent_java_version
        spring_port = _read_spring_port(child_path) or "8080"
        runtime_deps = _detect_spring_runtime_deps(child_path)
        # 合并父模块扫到的 deps(子模块 yml 缺失时父模块兜底)
        for k, v in parent_runtime_deps.items():
            if v:
                runtime_deps[k] = True
        run_args = _detect_spring_run_args(child_path, parent_path, root_path)
        # 子模块文档没说,继承 parent 文档的 profile / TLS 标志
        if not run_args.get("profile") and parent_run_args.get("profile"):
            run_args["profile"] = parent_run_args["profile"]
        if parent_run_args.get("needsTls12"):
            run_args["needsTls12"] = True
        children.append({
            "dir": parent_dir,            # volume 挂 parent 目录
            "kind": "java",
            "image": _maven_image_for_java(java_version),
            "port": spring_port,
            "confidence": "high",
            "maven_module": module_name,  # 传给 -pl 参数
            "_service_name": module_name, # 服务名用模块名更清晰
            "_java_version": java_version,
            "_runtime_deps": runtime_deps,
            "_spring_run_args": run_args,
            "_maven_siblings": list(sibling_modules),  # v0.6.7 Bug S
        })
    return children


def _is_spring_boot_pom(pom_path: str) -> bool:
    """判断 pom.xml 是否是 Spring Boot 应用模块（含 spring-boot-maven-plugin）。"""
    try:
        with open(pom_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return "spring-boot-maven-plugin" in content or "SpringBootApplication" in content
    except Exception:
        return False


def _is_maven_parent_pom(pom_path: str) -> bool:
    """判断 pom.xml 是否是 Maven 多模块父 pom（含 <modules>）。"""
    try:
        with open(pom_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return "<modules>" in content and "packaging>pom" in content
    except Exception:
        return False


def _normalize_port(raw: str) -> str | None:
    try:
        port = int(raw)
    except (TypeError, ValueError):
        return None
    if 1 <= port <= 65535:
        return str(port)
    return None


def _extract_js_object_body(text: str, key: str) -> str | None:
    import re
    m = re.search(r"\b" + re.escape(key) + r"\s*:\s*\{", text)
    if not m:
        return None
    open_idx = m.end() - 1
    depth = 0
    for idx in range(open_idx, len(text)):
        ch = text[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:idx]
    return None


def _extract_top_level_numeric_prop(object_body: str, key: str, max_digits: int = 5) -> str | None:
    import re
    depth = 0
    top_chars: list[str] = []
    for ch in object_body:
        if ch == "{":
            depth += 1
            top_chars.append(" ")
            continue
        if ch == "}":
            depth = max(0, depth - 1)
            top_chars.append(" ")
            continue
        top_chars.append(ch if depth == 0 else " ")
    top_text = "".join(top_chars)
    m = re.search(r"\b" + re.escape(key) + r"\s*:\s*(\d{1," + str(max_digits) + r"})\b", top_text)
    return m.group(1) if m else None


def _read_vite_port(sub_path: str) -> str:
    """尝试从 vite.config.ts/js 读取 server.port，读不出来返回 '3000'。"""
    import re

    for cfg_name in ("vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"):
        cfg_path = os.path.join(sub_path, cfg_name)
        if not os.path.exists(cfg_path):
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            # 只识别 server 顶层 port，避免误抓 preview.port / hmr.port。
            server_block = _extract_js_object_body(content, "server")
            raw_port = _extract_top_level_numeric_prop(server_block, "port", 5) if server_block else None
            if raw_port is not None:
                validated = _normalize_port(raw_port)
                if validated:
                    return validated
        except Exception:
            pass
    # 也检查 package.json scripts 中的 --port
    pkg_path = os.path.join(sub_path, "package.json")
    if os.path.exists(pkg_path):
        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg = json.load(f)
            scripts = pkg.get("scripts", {})
            for v in scripts.values():
                if isinstance(v, str):
                    m = re.search(r"--port[=\s]+(\d{1,5})", v)
                    if m:
                        validated = _normalize_port(m.group(1))
                        if validated:
                            return validated
        except Exception:
            pass
    return "3000"


def _git_remote_url(root: str) -> str | None:
    """从 root 目录获取 git remote origin URL，失败返回 None。"""
    import subprocess as _sp
    try:
        result = _sp.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, cwd=root, timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
    except Exception:
        pass
    return None


def _detect_modules(root: str) -> list[dict]:
    """子目录扫描:每个有 manifest 的子目录起一个 service。

    支持：Node/Vite（自动读端口）、.NET、Go、Rust、Python、Java Maven/Spring Boot。
    """
    modules: list[dict] = []
    skip = {"node_modules", "dist", "build", "target", ".git", ".cds-repos",
            ".vscode", ".idea", ".next", ".nuxt", "venv", ".venv"}

    def _detect_one(sub_path: str, sub: str) -> dict | None:
        # Java Maven (Spring Boot 优先)
        pom = os.path.join(sub_path, "pom.xml")
        if os.path.exists(pom):
            if _is_maven_parent_pom(pom):
                # 标记为 parent pom，调用方负责展开子模块
                return {"dir": sub, "kind": "_maven_parent",
                        "_pom_path": pom, "_sub_path": sub_path}
            java_version = _read_java_version_from_pom(pom)
            spring_port = _read_spring_port(sub_path) or "8080"
            runtime_deps = _detect_spring_runtime_deps(sub_path)
            # Issue #566 缺陷 #7:把仓库根传下去,让 AGENTS.md 在仓库根时也能扫到
            run_args = _detect_spring_run_args(sub_path, None, root)
            return {
                "dir": sub, "kind": "java",
                "image": _maven_image_for_java(java_version),
                "port": spring_port,
                "confidence": "high" if _is_spring_boot_pom(pom) else "medium",
                "_java_version": java_version,
                "_runtime_deps": runtime_deps,
                "_spring_run_args": run_args,
            }
        if os.path.exists(os.path.join(sub_path, "package.json")):
            port = _read_vite_port(sub_path)
            return {"dir": sub, "kind": "node", "image": "node:22-slim", "port": port, "confidence": "high"}
        if any(f.endswith(".csproj") for f in _walk(sub_path, depth=2)):
            return {"dir": sub, "kind": "dotnet",
                    "image": "mcr.microsoft.com/dotnet/sdk:8.0", "port": "5000", "confidence": "high"}
        if os.path.exists(os.path.join(sub_path, "go.mod")):
            return {"dir": sub, "kind": "go",
                    "image": "golang:1.22-alpine", "port": "8080", "confidence": "high"}
        if os.path.exists(os.path.join(sub_path, "Cargo.toml")):
            return {"dir": sub, "kind": "rust", "image": "rust:1.78", "port": "3000", "confidence": "high"}
        if (os.path.exists(os.path.join(sub_path, "requirements.txt"))
                or os.path.exists(os.path.join(sub_path, "pyproject.toml"))):
            return {"dir": sub, "kind": "python",
                    "image": "python:3.12-slim", "port": "8000", "confidence": "high"}
        return None

    def _add_mod(mod: dict) -> None:
        if mod.get("kind") == "_maven_parent":
            # 展开 parent pom：只收 Spring Boot 子模块,把 root 传下去扫 AGENTS.md
            children = _expand_maven_parent(
                mod["_sub_path"], mod["dir"], mod["_pom_path"], root_path=root)
            modules.extend(children)
        else:
            modules.append(mod)

    # 先看根目录本身
    root_mod = _detect_one(root, ".")
    if root_mod:
        _add_mod(root_mod)

    # 再扫一层子目录（不管 root 是否有模块，确保 monorepo 各子目录都被扫到）
    try:
        entries = os.listdir(root)
    except Exception:
        entries = []
    for sub in sorted(entries):
        if sub in skip or sub.startswith("."):
            continue
        sub_path = os.path.join(root, sub)
        if not os.path.isdir(sub_path):
            continue
        mod = _detect_one(sub_path, sub)
        if mod:
            _add_mod(mod)
    return modules


def _extract_real_infra_env_overrides(tpl: dict, svc_def: dict) -> dict[str, str]:
    """v0.6.7 Bug K: 从用户原 docker-compose 的 infra service.environment 里提取
    真实字面值,反查 template.service_env 拿到对应的 ${CDS_*} 占位 key,返回
    {CDS_MYSQL_USER: "imp_user", CDS_MYSQL_DATABASE: "imp_db", ...} 这样的覆盖表。

    例如 template.service_env = {"MYSQL_USER": "${CDS_MYSQL_USER}", ...}
        svc_def.environment = {"MYSQL_USER": "imp_user", "MYSQL_DATABASE": "imp_db"}
    返回 {"CDS_MYSQL_USER": "imp_user", "CDS_MYSQL_DATABASE": "imp_db"}.

    跳过仍然是 ${...} 占位的字段(说明用户没写真实值,继续走 template default)。
    """
    import re
    overrides: dict[str, str] = {}
    tpl_service_env = tpl.get("service_env") or {}
    if not isinstance(tpl_service_env, dict):
        return overrides
    # 反查表: docker-compose env name → CDS key 名(从模板里 ${CDS_*} 占位提取)
    name_to_cds_key: dict[str, str] = {}
    for env_name, tpl_value in tpl_service_env.items():
        if not isinstance(tpl_value, str):
            continue
        m = re.match(r"^\$\{([A-Z_][A-Z0-9_]*)\}$", tpl_value.strip())
        if m:
            name_to_cds_key[env_name] = m.group(1)
    if not name_to_cds_key:
        return overrides
    svc_env = svc_def.get("environment") or {}
    # docker-compose 环境支持 dict 或 list("KEY=value")
    if isinstance(svc_env, list):
        parsed: dict[str, str] = {}
        for item in svc_env:
            if isinstance(item, str) and "=" in item:
                k, v = item.split("=", 1)
                parsed[k.strip()] = v.strip()
        svc_env = parsed
    if not isinstance(svc_env, dict):
        return overrides
    for env_name, cds_key in name_to_cds_key.items():
        raw = svc_env.get(env_name)
        if raw is None:
            continue
        sval = str(raw).strip()
        # 跳过 ${...} 占位 / 空串
        if not sval or sval.startswith("${"):
            continue
        overrides[cds_key] = sval
    return overrides


def _find_init_sql_dirs(root: str, max_depth: int = 4) -> list[str]:
    """v0.6.7 Bug L: 在项目内查找 mysql 初始化 SQL 目录(*.sql under **/mysql/init/)。
    返回相对 root 的目录路径列表(POSIX 风格,前缀 ./)。多个匹配按字典序返回。
    """
    skip = {"node_modules", "dist", "build", "target", ".git", ".cds-repos",
            ".vscode", ".idea", ".next", ".nuxt", "venv", ".venv"}
    matches: list[str] = []
    if not os.path.isdir(root):
        return matches
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过常见噪声目录
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
        # 限制扫描深度
        depth = dirpath[len(root):].count(os.sep)
        if depth > max_depth:
            dirnames[:] = []
            continue
        # 命中 .../mysql/init 目录,且其下有 .sql
        norm = dirpath.replace(os.sep, "/")
        if norm.endswith("/mysql/init") and any(f.endswith(".sql") for f in filenames):
            rel = os.path.relpath(dirpath, root).replace(os.sep, "/")
            matches.append("./" + rel if not rel.startswith(".") else rel)
    return sorted(matches)


def _detect_nacos_required_configs(root: str) -> list[str]:
    """v0.6.7 Bug M: 扫所有 **/bootstrap.yml/yaml,提取
    spring.cloud.nacos.config.shared-configs[].dataId,返回去重后的 dataId 列表。

    宽松正则匹配(不依赖 PyYAML),覆盖最常见格式:
      shared-configs:
        - dataId: ticket-platform-secrets.yaml
        - data-id: another.yaml  # spring 也支持连字符形式
    也兼容 refresh: true / group: DEFAULT 这类同级字段。
    """
    import re
    skip = {"node_modules", "dist", "build", "target", ".git", ".cds-repos",
            ".vscode", ".idea", ".next", ".nuxt", "venv", ".venv"}
    found: list[str] = []
    seen: set[str] = set()
    if not os.path.isdir(root):
        return found
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
        depth = dirpath[len(root):].count(os.sep)
        if depth > 6:
            dirnames[:] = []
            continue
        for fname in filenames:
            if fname not in ("bootstrap.yml", "bootstrap.yaml"):
                continue
            path = os.path.join(dirpath, fname)
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except Exception:
                continue
            # 定位 shared-configs: 块,然后抓 dataId / data-id
            block = re.search(r"(?ms)shared-configs\s*:\s*\n((?:[ \t]+[^\n]*\n?)+)", text)
            if not block:
                continue
            for m in re.finditer(r"data[-_]?[Ii]d\s*:\s*['\"]?([^\s'\",}]+)", block.group(1)):
                data_id = m.group(1).strip()
                if data_id and data_id not in seen:
                    seen.add(data_id)
                    found.append(data_id)
    return found


def _yaml_from_modules(root: str, modules: list[dict],
                       infra_services: dict | None = None,
                       scan_signals: dict | None = None) -> str:
    """从 monorepo 模块扫描结果生成 yaml。无模块时输出骨架 + 提示。

    Issue #566 缺陷 #9 / mdimp 缺陷 #5:scan_signals 落到 x-cds-signals 顶层 key,
    让 verify / Agent 即便只看 YAML 也能感知 partial / missingInfra / warnings。
    Issue #544 / #561 / #566 缺陷 #3:infra_services(嵌套合并 + 自动生成)注入到 services 段。
    """
    project_name = os.path.basename(root)
    repo_url = _git_remote_url(root)
    repo_line = f"  repo: \"{repo_url}\"" if repo_url else "  repo: \"TODO: 请填写仓库地址\""

    # Issue #566 缺陷 #10 (CRITICAL):自动生成的 infra service 引用 ${CDS_*} 占位,
    # 必须把对应 _INFRA_TEMPLATES 的 global_env 同步声明到 x-cds-env / x-cds-env-meta,
    # 否则 verify 自家 env-var-unresolved 立刻报 ERROR,部署也起不来。
    # 收集 final_infra services 命中的 templates,展开 global_env(value=None 时 _gen_password)。
    #
    # v0.6.7 Bug K: 用户 docker-compose 显式声明了 MYSQL_USER/MYSQL_DATABASE/MYSQL_PASSWORD
    # 等真实值时,反查模板的 service_env 拿到对应 ${CDS_*} 占位,**用真实值覆盖**
    # template default("app"/随机密码),否则应用通过 ${CDS_DATABASE_URL} 拿到的连接串
    # 用 `app` 用户连不上 DB(实际 mysql 容器只为 imp_user 建账号)。
    extra_env: dict[str, str] = {}
    extra_env_meta: list[tuple[str, str, str]] = []  # (key, kind, hint)
    seen_extra_keys: set[str] = set()
    if infra_services:
        for svc_name, svc_def in infra_services.items():
            if not isinstance(svc_def, dict):
                continue
            tpl = _find_infra_template(svc_def.get("image", "") or "")
            if not tpl:
                continue
            # v0.6.7 Bug K: 反查 template.service_env 构建 ${CDS_*} → CDS env key 映射,
            # 然后从 svc.environment 里把字面值挑出来覆盖 default。
            real_env_overrides = _extract_real_infra_env_overrides(tpl, svc_def)
            for entry in (tpl.get("global_env") or []):
                # entry: (key, default, required, hint)
                key = entry[0]
                default = entry[1] if len(entry) > 1 else None
                required = entry[2] if len(entry) > 2 else False
                hint = entry[3] if len(entry) > 3 else ""
                if key in seen_extra_keys or key == "CDS_JWT_SECRET":
                    continue
                seen_extra_keys.add(key)
                # v0.6.7 Bug K: 用户在 docker-compose 里写了真实值就用真实值
                if key in real_env_overrides:
                    extra_env[key] = real_env_overrides[key]
                    extra_env_meta.append((key, "user-required", hint))
                    continue
                if default is None:
                    # 密码类:CDS 自动随机生成
                    extra_env[key] = _gen_password()
                    extra_env_meta.append((key, "auto", hint))
                elif required:
                    extra_env[key] = default
                    extra_env_meta.append((key, "user-required", hint))
                else:
                    extra_env[key] = default
                    extra_env_meta.append((key, "auto", hint))

    lines: list[str] = [
        "# CDS Compose 配置 — 由 cdscli scan 从子目录扫描自动生成",
        "# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴",
        "",
        "x-cds-project:",
        f"  name: {project_name}",
        f"  description: \"{project_name} 全栈项目\"",
        repo_line,
        "",
        "x-cds-env:",
        "  # 项目级环境变量(本项目独占,不会跨项目泄漏 / 污染其它项目)",
        "  # CDS_* 前缀 = CDS 自动生成 / 命名空间归 CDS 所有",
        f"  CDS_JWT_SECRET: \"{_gen_password()}\"",
    ]
    # Issue #566 缺陷 #10:auto-infra 的 ${CDS_*} 占位同步落 x-cds-env
    if extra_env:
        for k in sorted(extra_env.keys()):
            v = extra_env[k]
            # ${...} 引用类不加引号;字面值加双引号
            if isinstance(v, str) and v.startswith("${") and v.endswith("}"):
                lines.append(f"  {k}: {v}")
            else:
                lines.append(f"  {k}: \"{v}\"")
    lines += [
        "",
        "# Phase 8:env 三色 metadata — CDS 弹窗强制用户填 required",
        "x-cds-env-meta:",
        "  CDS_JWT_SECRET:",
        "    kind: auto",
        "    hint: \"CDS 自动生成的 JWT 签名密钥\"",
    ]
    if extra_env_meta:
        for key, kind, hint in extra_env_meta:
            lines.append(f"  {key}:")
            lines.append(f"    kind: {kind}")
            lines.append(f"    hint: \"{hint}\"")
    # v0.6.7 Bug M: 解析 **/bootstrap.yml 的 spring.cloud.nacos.config.shared-configs,
    # 输出 x-cds-nacos-required-configs 提醒 import 时手工 seed 到 nacos。
    nacos_required = _detect_nacos_required_configs(root)
    if nacos_required:
        lines += [
            "",
            "# v0.6.7 Bug M:Spring Cloud Nacos shared-configs 列表 — 应用 bootstrap.yml",
            "# 引用了这些 dataId,CDS import 后必须在 nacos 控制台 seed 这些配置,",
            "# 否则应用启动时拉不到配置直接退出。",
            "x-cds-nacos-required-configs:",
        ]
        for data_id in nacos_required:
            lines.append(f"  - \"{data_id}\"")
    lines += [
        "",
        "services:",
    ]
    if not modules:
        lines.append("  # TODO: 未识别已知栈,请手动补全 services 段")
        lines.append("  # 示例:")
        lines.append("  # api:")
        lines.append("  #   image: ubuntu:24.04")
        lines.append("  #   command: \"echo replace me\"")
        return "\n".join(lines) + "\n"

    # v0.6.6:扫到 nacos infra service → Java 服务自动注入 NACOS_SERVER_ADDR 等
    nacos_service_name: str | None = None
    if infra_services:
        for _svc_name, _svc_def in infra_services.items():
            if not isinstance(_svc_def, dict):
                continue
            _img = (_svc_def.get("image") or "").lower()
            if "nacos" in _img:
                nacos_service_name = _svc_name
                break

    # Issue #560:先确定第一个 java 服务名,前端要把 VITE_API_BASE_URL 指向它
    primary_java_service: str | None = None
    primary_java_port: str = "8080"
    for mod in modules:
        if mod.get("kind") == "java":
            primary_java_service = (mod.get("_service_name")
                                    or (mod["dir"] if mod["dir"] != "." else project_name))
            primary_java_service = primary_java_service.replace("prd-", "").replace("project-", "")
            primary_java_port = mod.get("port") or "8080"
            break

    for i, mod in enumerate(modules):
        # Maven multi-module: use module name as service name, parent dir for volumes
        if mod.get("_service_name"):
            raw_name = mod["_service_name"]
        else:
            raw_name = mod["dir"] if mod["dir"] != "." else project_name
        # 简化 name(去掉 prd- 前缀这种)
        clean_name = raw_name.replace("prd-", "").replace("project-", "")
        kind = mod["kind"]
        lines.append(f"  {clean_name}:")
        lines.append(f"    image: {mod['image']}")
        lines.append(f"    working_dir: /app")
        lines.append(f"    volumes:")
        lines.append(f"      - ./{mod['dir']}:/app")
        # v0.6.3 备注:Node service 不在这里再加 node_modules named volume —
        # CDS container.ts 会自动给 pnpm command 挂 cds-nm-<branch>-<profile>
        # 的 docker named volume 到 /app/node_modules,我们再写一份会触发
        # "Duplicate mount point" 错误。npm/yarn 项目 CDS 不挂(为了避免装错版本),
        # 这种项目要么改用 pnpm,要么 command 不要 rm -rf node_modules。
        lines.append(f"    ports:")
        lines.append(f"      - \"{mod['port']}\"")
        # v0.6.5:Node 服务统一注入 env(strict-builds 关闭 + 可选 VITE API 反代)
        if kind == "node":
            node_env: list[tuple[str, str]] = []
            # v0.6.5:绕开 pnpm 11 ERR_PNPM_IGNORED_BUILDS;双保险开关
            node_env.append(("NPM_CONFIG_STRICT_BUILDS", "false"))
            node_env.append(("PNPM_IGNORE_SCRIPTS", "false"))
            # v0.6.6:关掉 corepack 下载 pnpm 时的 Y/n 交互提示,否则容器 hang 住
            node_env.append(("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0"))
            # Issue #560:Vite 前端引用 VITE_*_API_* 时,把 base 指向后端容器
            if primary_java_service:
                sub_path_for_env = os.path.join(root, mod["dir"]) if mod["dir"] != "." else root
                api_keys = _detect_vite_api_env_keys(sub_path_for_env)
                if api_keys:
                    api_target = f"http://{primary_java_service}:{primary_java_port}"
                    for key in api_keys:
                        node_env.append((key, api_target))
            lines.append(f"    environment:")
            for k, v in node_env:
                lines.append(f"      {k}: \"{v}\"")
            # v0.6.5:命令行也带 --config.strict-builds=false,兜底 env 不生效场景
            lines.append(f"    command: corepack enable && pnpm install --frozen-lockfile --config.strict-builds=false && pnpm exec vite --host 0.0.0.0 --port {mod['port']}")
        elif kind == "java":
            run_args = mod.get("_spring_run_args") or {}
            extra = ""
            if run_args.get("profile"):
                extra += f" -Dspring-boot.run.profiles={run_args['profile']}"
            if run_args.get("needsTls12"):
                extra += " -Djdk.tls.client.protocols=TLSv1.2"
            # v0.6.6:扫到 nacos infra → 注入 server-addr,Spring Cloud Nacos 拿配置中心
            if nacos_service_name:
                nacos_addr = f"{nacos_service_name}:8848"
                lines.append(f"    environment:")
                lines.append(f"      NACOS_SERVER_ADDR: \"{nacos_addr}\"")
                lines.append(f"      SPRING_CLOUD_NACOS_DISCOVERY_SERVER_ADDR: \"{nacos_addr}\"")
                lines.append(f"      SPRING_CLOUD_NACOS_CONFIG_SERVER_ADDR: \"{nacos_addr}\"")
            maven_module = mod.get("maven_module")
            if maven_module:
                # v0.6.7 Bug S(替代旧 v0.6.5 写法):multi-module 拆两段
                # 1) 在 parent 目录 install 所有 sibling(`-pl <modules>,-<runModule>`
                #    用 maven 反向选择语法:列出全部 + 排除 runModule)
                # 2) `cd <runModule>` 后直接跑 spring-boot:run,避免 parent reactor
                #    跑 spring-boot:run 时找不到 mainClass(mdimp imp-api 实测踩过)
                siblings = mod.get("_maven_siblings") or []
                # 兄弟列表去掉自己,留下需要 install 的
                other_modules = [m for m in siblings if m != maven_module]
                lines.append(f"    command: |")
                if other_modules:
                    install_pl = ",".join(other_modules) + f",-{maven_module}"
                    lines.append(f"      mvn install -DskipTests -q -pl {install_pl}")
                else:
                    # 单模块 parent(理论上不会走到这里,兜底)
                    lines.append(f"      mvn install -DskipTests -q")
                lines.append(f"      cd {maven_module} && mvn spring-boot:run -DskipTests{extra}")
            elif mod.get("confidence") == "high":  # Spring Boot confirmed via spring-boot-maven-plugin
                lines.append(f"    command: mvn spring-boot:run -DskipTests{extra}")
            else:  # plain Maven, no spring-boot-maven-plugin detected
                lines.append(f"    command: mvn package -DskipTests && java -jar target/*.jar  # TODO: 请确认 jar 文件名")
            # 后端运行时依赖告警(Issue #561):MySQL/Redis/MinIO 等扫到却没生成 infra
            deps = mod.get("_runtime_deps") or {}
            missing_infra = [k for k, v in deps.items() if v]
            if missing_infra:
                lines.append(f"    # TODO infra: 检测到依赖 {', '.join(missing_infra)}; 请在本 compose 加 infra 服务或在 CDS 复用共享 infra")
        elif kind == "dotnet":
            lines.append(f"    command: dotnet run --urls http://0.0.0.0:{mod['port']}  # TODO: 改为实际入口")
        elif kind == "go":
            lines.append(f"    command: go run ./...")
        elif kind == "rust":
            lines.append(f"    command: cargo run")
        elif kind == "python":
            lines.append(f"    command: pip install -r requirements.txt && python -m http.server {mod['port']}")
        lines.append(f"    labels:")
        # Issue #560:Spring Boot 真实路由不是 /<module>/,而是 /api,/partner,/open,/actuator
        # 用 cds.path-prefixes 暴露完整列表,避免前端调 /api 打不到后端
        if kind == "java":
            prefixes = "/api/,/partner/,/open/,/health,/actuator/"
            lines.append(f"      cds.path-prefix: \"/api/\"  # 兼容:CDS 单 prefix 路由")
            lines.append(f"      cds.path-prefixes: \"{prefixes}\"  # 多前缀:覆盖 Spring Boot 真实入口")
            # v0.6.3:Maven 首次 build 要 3-5 分钟下依赖,CDS 默认 readiness 180s 不够
            # 写 600s(10min) — 单次部署足够,后续 .m2 缓存命中只需 30-60s
            lines.append(f"      cds.readiness-timeout: \"600\"  # v0.6.3:maven build 留 10min")
            lines.append(f"      cds.readiness-interval: \"5\"   # v0.6.3:5s 一次,running 后立刻反应")
            # v0.6.5:CDS HTTP 探测在 build-heavy 服务上误判,只看容器是否退出
            lines.append(f"      cds.no-http-readiness: \"true\" # v0.6.5:绕过 HTTP probe,只看容器存活")
        else:
            prefix = "/" if i == 0 else f"/{clean_name}/"
            lines.append(f"      cds.path-prefix: \"{prefix}\"")
            # v0.6.3:Node 前端 build(vite/webpack)有时也要 60-120s,稍微放宽
            lines.append(f"      cds.readiness-timeout: \"300\"  # v0.6.3:vite/webpack build 留 5min")
            # v0.6.5:vite dev server 启动有时不响应 HTTP HEAD,绕过 probe
            lines.append(f"      cds.no-http-readiness: \"true\" # v0.6.5:绕过 HTTP probe,只看容器存活")

    # Issue #544 / #561 / #566 缺陷 #3:渲染 infra services(自动生成 + 嵌套合并)
    # v0.6.7 Bug L:mysql 镜像 + 项目内存在 **/mysql/init/*.sql → 自动挂
    # /docker-entrypoint-initdb.d:ro,否则 mysql 启动后表是空的需手工灌。
    init_sql_dirs = _find_init_sql_dirs(root) if infra_services else []
    if infra_services:
        for svc_name in sorted(infra_services.keys()):
            svc = infra_services[svc_name] or {}
            lines.append(f"  {svc_name}:")
            if svc.get("image"):
                lines.append(f"    image: {svc['image']}")
            if svc.get("command"):
                cmd_val = svc["command"]
                if isinstance(cmd_val, list):
                    cmd_val = " ".join(str(x) for x in cmd_val)
                lines.append(f"    command: {cmd_val}")
            env = svc.get("environment") or {}
            if isinstance(env, dict) and env:
                lines.append(f"    environment:")
                for k, v in env.items():
                    lines.append(f"      {k}: \"{v}\"")
            elif isinstance(env, list) and env:
                lines.append(f"    environment:")
                for item in env:
                    lines.append(f"      - {item}")
            ports = svc.get("ports")
            if ports:
                lines.append(f"    ports:")
                if isinstance(ports, list):
                    for p in ports:
                        lines.append(f"      - \"{p}\"")
                else:
                    lines.append(f"      - \"{ports}\"")
            # v0.6.7 Bug L: 给 mysql/mariadb 自动加 init dir 挂载
            existing_vols = list(svc.get("volumes") or []) if isinstance(svc.get("volumes"), list) else []
            image_lc = (svc.get("image") or "").lower()
            is_mysql_like = ("mysql" in image_lc or "mariadb" in image_lc)
            already_has_initdb = any(
                "/docker-entrypoint-initdb.d" in str(v) for v in existing_vols
            )
            auto_init_mounts: list[str] = []
            if is_mysql_like and not already_has_initdb and init_sql_dirs:
                for d in init_sql_dirs:
                    auto_init_mounts.append(f"{d}:/docker-entrypoint-initdb.d:ro")
            if existing_vols or auto_init_mounts:
                lines.append(f"    volumes:")
                for v in existing_vols:
                    lines.append(f"      - {v}")
                for v in auto_init_mounts:
                    lines.append(f"      - \"{v}\"  # v0.6.7 Bug L:cdscli 自动挂 init SQL")
            labels = svc.get("labels")
            if labels and isinstance(labels, dict):
                lines.append(f"    labels:")
                for k, v in labels.items():
                    lines.append(f"      {k}: \"{v}\"")

    # Issue #566 缺陷 #9 / mdimp 缺陷 #5:scan signals 持久化进 YAML(让 verify / 下游 Agent 看得到)
    if scan_signals:
        s = scan_signals
        # 只输出关键白名单字段,避免 root/source 等噪声
        keys = ("status", "partialReason", "warnings", "missingInfra",
                "skippedComposeFiles", "mergedInfraFromNested",
                "mergedFromFiles", "autoInfraGenerated", "frontendApiEnv",
                "javaModules")
        present = {k: s[k] for k in keys if k in s and s[k]}
        if present:
            lines.append("")
            lines.append("# x-cds-signals: cdscli scan 阶段产生的诊断信号(verify 会读这块降级判定)")
            lines.append("x-cds-signals:")
            for k in keys:
                if k not in present:
                    continue
                v = present[k]
                if isinstance(v, str):
                    lines.append(f"  {k}: \"{v}\"")
                elif isinstance(v, list):
                    if not v:
                        continue
                    lines.append(f"  {k}:")
                    for item in v:
                        if isinstance(item, dict):
                            # 只展平一层,够用
                            first = True
                            for ik, iv in item.items():
                                if first:
                                    lines.append(f"    - {ik}: \"{iv}\"")
                                    first = False
                                else:
                                    lines.append(f"      {ik}: \"{iv}\"")
                        else:
                            lines.append(f"    - \"{item}\"")
                elif isinstance(v, dict):
                    lines.append(f"  {k}:")
                    for ik, iv in v.items():
                        lines.append(f"    {ik}: \"{iv}\"")

    # v0.6.3:扫描所有 service.volumes,把 named volumes(非相对、非绝对路径源)
    # 收集到顶层 volumes: 段。docker compose 在源是 named volume 时,顶层
    # 不声明会拒绝部署("named volume not declared")。我们的 cds-nm-* 就是这种。
    import re as _re
    named_vols = set()
    for line in lines:
        # 匹配 "      - <name>:/path" 形式,提取 name 部分
        m = _re.match(r"^      - ([A-Za-z][A-Za-z0-9_.-]*):/", line)
        if m:
            named_vols.add(m.group(1))
    if named_vols:
        lines.append("")
        lines.append("volumes:")
        for nv in sorted(named_vols):
            lines.append(f"  {nv}: {{}}")

    return "\n".join(lines) + "\n"


def _emit_scan_result(args: argparse.Namespace, yaml_content: str,
                      signals: dict, note: str) -> None:
    """统一处理 --apply-to-cds / --output / stdout 三种输出。"""
    if args.apply_to_cds:
        pid = args.apply_to_cds
        status, body, _ = _request(
            "POST", f"/api/projects/{urllib.parse.quote(pid)}/pending-import",
            body={"agentName": "cdscli", "purpose": "cdscli scan --apply-to-cds",
                  "composeYaml": yaml_content}, timeout=30,
        )
        if status >= 400:
            die(f"提交失败 HTTP {status}: {body}", code=2 if status < 500 else 3)
        import_id = body.get("importId") if isinstance(body, dict) else None
        approve_url = f"{_cds_base()}/project-list?pendingImport={import_id}"
        ok({"importId": import_id, "approveUrl": approve_url, "signals": signals,
            "yamlLen": len(yaml_content)},
           note=f"已提交待批 (importId={import_id}), 去 {approve_url} 批准")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(yaml_content)
        ok({"signals": signals, "writtenTo": args.output},
           note=f"YAML 已写入 {args.output}: {note}")
    ok({"signals": signals, "yaml": yaml_content}, note=note)


# ── cdscli verify(2026-05-01,Phase 2.5)──────────────────────────
#
# 在 scan 之后立刻校验生成的 yaml(或仓库已有的 cds-compose.yml),
# 把"部署一定挂"的硬错误 + "很可能挂"的警告 + "可优化"的提示分级输出。
# 这是把过去 7 个 geo 实战根因(volumes 路径 / port 错位 / dependsOn 漏 /
# schemaful DB 缺 migration / 密码转义)在 scan 端提前拦截的入口。
#
# 校验规则的 SSOT 在 doc/spec.cds-compose-contract.md § 4。

_SCHEMAFUL_DB_NAMES = {"mysql", "mariadb", "postgres", "postgresql", "sqlserver", "mssql", "oracle", "db2"}
_MIGRATION_KEYWORDS = ["migrate", "prisma", "ef database update", "sequelize-cli", "flyway", "rake db:migrate", "alembic upgrade"]
_URL_UNSAFE_CHARS = set("!@#$&+/?")  # 出现在密码里需 URL encode 才能放进连接串


def _verify_load_compose(root: str, explicit_file: str | None = None) -> tuple[str, dict] | None:
    """按 CDS 探测顺序找 compose 文件并解析。返回 (path, doc) 或 None。

    explicit_file: 若传入非 None，直接加载该文件（支持自定义文件名如 cds-comose.yml）。
    """
    try:
        import yaml  # type: ignore
    except ImportError:
        # 尝试自动安装到用户目录，避免让用户手动操作
        import subprocess as _sp
        try:
            _sp.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "--user", "pyyaml"],
                stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
            )
            import importlib as _il
            _il.invalidate_caches()
            import yaml  # type: ignore  # noqa: F811
        except Exception:
            die(
                "verify 需要 PyYAML，自动安装失败。\n"
                "请手动执行: pip install pyyaml（或 python3 -m pip install pyyaml）\n"
                "若无 pip，可用: python3 -m ensurepip --upgrade && python3 -m pip install pyyaml",
                code=4,
            )

    if explicit_file:
        path = explicit_file if os.path.isabs(explicit_file) else os.path.join(root, explicit_file)
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            try:
                doc = yaml.safe_load(f.read()) or {}
            except Exception as e:
                die(f"解析 {os.path.basename(path)} 失败: {e}", code=2)
        if not isinstance(doc, dict):
            die(f"{os.path.basename(path)} 顶层不是 dict，无法 verify", code=2)
        return path, doc

    candidates = [
        "cds-compose.yml", "cds-compose.yaml",
        "docker-compose.yml", "docker-compose.yaml",
        "docker-compose.dev.yml", "docker-compose.dev.yaml",
        "compose.yml", "compose.yaml",
    ]
    for name in candidates:
        path = os.path.join(root, name)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            try:
                doc = yaml.safe_load(f.read()) or {}
            except Exception as e:
                die(f"解析 {name} 失败: {e}", code=2)
        if not isinstance(doc, dict):
            die(f"{name} 顶层不是 dict,无法 verify", code=2)
        return path, doc
    return None


def _verify_collect_env_keys(doc: dict) -> set[str]:
    """收集所有 x-cds-env 顶层 key,用于解析 ${VAR}。"""
    env = doc.get("x-cds-env") or {}
    return set(env.keys()) if isinstance(env, dict) else set()


def _verify_extract_var_refs(value: str) -> list[str]:
    """从字符串里抽出所有 ${VAR} 引用名(不含 :- 默认值场景)。"""
    import re
    if not isinstance(value, str):
        return []
    return re.findall(r"\$\{(\w+)(?::-[^}]*)?\}", value)


def _verify_has_default(value: str, var: str) -> bool:
    """判断 ${VAR:-default} 形式是否带 default。"""
    import re
    return bool(re.search(rf"\$\{{{re.escape(var)}:-[^}}]*\}}", value or ""))


def _verify_is_app_service(svc: dict) -> bool:
    """与 TS `isAppServiceCandidate`(cds/src/services/compose-parser.ts)完全对齐。

    app 候选当且仅当满足下列任一:
      - 有"应用源码"挂载(./xxx:/path,排除 init / 配置文件挂载)— 强信号
      - 有 `build:` 指令且 *无* docker-level healthcheck

    后者把 `build: ./backend` 这类没声明 source mount 的应用服务也算 app(否则
    verify 会跳过 `_verify_app_workdir` / `_verify_app_ports`,让 app 漏检);
    同时把 `build: ./custom-postgres` + healthcheck 这种自建 infra 留在 infra 侧。

    Bugbot fix(PR #521 第十二轮 Bug 1)— 排除 init script / 配置文件挂载,
    防止 mysql 自带 `./init.sql:/docker-entrypoint-initdb.d/` 被误归 app。

    Bugbot fix(PR #521 第十五轮)— 补齐 build + no-healthcheck 分支,与 TS
    `isAppServiceCandidate` 真正对齐(之前 docstring 声称对齐 TS 但只覆盖
    源码挂载分支,build-only 应用在 verify 路径被错归 infra 漏检)。
    """
    vols = svc.get("volumes") or []
    if isinstance(vols, list) and any(_is_app_source_mount(v) for v in vols if isinstance(v, str)):
        return True
    if not svc.get("build"):
        return False
    healthcheck = svc.get("healthcheck")
    has_docker_healthcheck = (
        isinstance(healthcheck, dict) and healthcheck.get("test") is not None
    )
    return not has_docker_healthcheck


def _resolve_project_root(yaml_root: str, svc_volumes: list[str]) -> str:
    """mdimp 缺陷 #3:YAML 不在项目根时,verify 应聪明定位到真实项目根。

    策略:
      1. 收集 volumes 的相对源路径(./imp-admin 等)
      2. 候选目录 = yaml_root + 向上 5 级祖先 + yaml_root 一层子目录(覆盖 YAML 在 /tmp,
         项目在 /tmp/fix_fixture 的场景)
      3. 选第一个能解析到所有/最多 volumes 的候选
    """
    if not yaml_root:
        return yaml_root
    rel_sources: list[str] = []
    for v in svc_volumes or []:
        if not isinstance(v, str):
            continue
        src = v.split(":")[0]
        if src.startswith("./") or src == ".":
            rel_sources.append(_strip_dot_slash(src) or ".")
    if not rel_sources:
        return yaml_root
    cur = os.path.abspath(yaml_root)
    candidates: list[str] = [cur]
    # 向上找祖先(最多 5 级)
    walk = cur
    for _ in range(5):
        parent = os.path.dirname(walk)
        if parent == walk:
            break
        candidates.append(parent)
        walk = parent
    # 向下找一层子目录(YAML 放在父目录、项目在子目录的常见误用)
    try:
        for sub in os.listdir(cur):
            sub_path = os.path.join(cur, sub)
            if os.path.isdir(sub_path) and not sub.startswith(".") and \
                    sub not in {"node_modules", "dist", "build", "target"}:
                candidates.append(sub_path)
    except Exception:
        pass
    # 选解析到 volume 数最多的候选(且 > 0);打平时优先 yaml_root
    best = yaml_root
    best_score = -1
    for cand in candidates:
        score = sum(1 for rel in rel_sources if os.path.isdir(os.path.join(cand, rel)))
        if score > best_score:
            best_score = score
            best = cand
    return best if best_score > 0 else yaml_root


def _verify_app_workdir(svc_name: str, svc: dict, root: str) -> list[dict]:
    """ERROR:app 的相对 mount workDir 在仓库根不存在。

    mdimp 缺陷 #3:如果 root(YAML 父目录)解析失败,自动向上找 .git/pom.xml 仓库根。
    """
    issues: list[dict] = []
    vols = svc.get("volumes") or []
    if not isinstance(vols, list):
        return issues
    # 第一步:尝试用更聪明的项目根做基准
    effective_root = _resolve_project_root(root, vols)
    for v in vols:
        if not isinstance(v, str):
            continue
        src = v.split(":")[0]
        if not (src.startswith("./") or src == "."):
            continue
        rel = _strip_dot_slash(src) or "."
        full = os.path.join(effective_root, rel)
        if not os.path.isdir(full):
            issues.append({
                "severity": "ERROR",
                "service": svc_name,
                "rule": "app-workdir-missing",
                "message": f"应用 {svc_name} 引用的相对路径 {src!r} 在仓库内不存在(实际查 {full})",
                "fix": f"确认仓库里有该子目录,或修正 cds-compose.yml 的 volumes 段",
            })
    return issues


def _verify_app_ports(svc_name: str, svc: dict) -> list[dict]:
    """ERROR:app 缺 ports 段。"""
    if not svc.get("ports"):
        return [{
            "severity": "ERROR",
            "service": svc_name,
            "rule": "app-ports-missing",
            "message": f"应用 {svc_name} 缺 ports: 段,CDS 不知道容器监听哪个端口",
            "fix": "ports 段加一项,如 ['3000'],数字必须等于应用代码真实监听端口",
        }]
    return []


def _verify_infra_image(svc_name: str, svc: dict) -> list[dict]:
    """ERROR:infra 既无 build 又无 image。"""
    if not svc.get("image") and not svc.get("build"):
        return [{
            "severity": "ERROR",
            "service": svc_name,
            "rule": "infra-image-missing",
            "message": f"基础设施 {svc_name} 既无 image 又无 build,CDS 无法启动",
            "fix": "加 image: <镜像>:<tag>,如 mongo:8.0 / mysql:8 / redis:7-alpine",
        }]
    return []


def _verify_env_resolves(svc_name: str, svc: dict, env_keys: set[str]) -> list[dict]:
    """ERROR:env 里的 ${VAR} 在 x-cds-env 里没定义,也无 default。

    CDS 运行时变量白名单（由 CDS 服务端在容器启动时注入，verify 阶段无法预知）：
      - CDS_HOST：CDS 服务地址
      - CDS_*_PORT：CDS 为每个 service 分配的端口变量
      - CDS_*_HOST：CDS 为每个 service 分配的 hostname 变量
      - CDS_*_URL：CDS 自动组装的连接串
    这些变量不需要在 x-cds-env 中定义，verify 不报 ERROR。
    """
    # CDS 运行时注入变量的后缀模式，详见 reference/scan.md
    # 仅包含 CDS 服务端自动分配的网络层变量（端口/主机名/连接串）。
    # _PASSWORD / _USER / _DB 等凭据变量不在此列——它们必须由项目在 x-cds-env 中显式定义。
    _CDS_RUNTIME_SUFFIXES = ("_PORT", "_HOST", "_URL")

    issues: list[dict] = []
    env = svc.get("environment") or {}
    env_self_keys = set(env.keys()) if isinstance(env, dict) else set()

    def _check_string(field_label: str, src_str: str) -> None:
        if not isinstance(src_str, str):
            return
        for var in _verify_extract_var_refs(src_str):
            if var in env_keys:
                continue
            if _verify_has_default(src_str, var):
                continue
            # 同 service environment 自身 key 也算定义
            if var in env_self_keys:
                continue
            # CDS 运行时变量白名单
            if var.startswith("CDS_") and any(var.endswith(sfx) for sfx in _CDS_RUNTIME_SUFFIXES):
                issues.append({
                    "severity": "INFO",
                    "service": svc_name,
                    "rule": "env-var-cds-runtime",
                    "message": f"{svc_name}.{field_label} 引用 ${{{var}}}，这是 CDS 运行时注入变量，无需在 x-cds-env 中定义",
                    "fix": "如需本地 verify 通过，可加 fallback: ${" + var + ":-localhost}",
                })
                continue
            issues.append({
                "severity": "ERROR",
                "service": svc_name,
                "rule": "env-var-unresolved",
                "message": f"{svc_name}.{field_label} 引用 ${{{var}}},但 x-cds-env 里没该变量也无默认值",
                "fix": f"在 x-cds-env 加 {var}: <值>,或改成 ${{{var}:-fallback}}",
                "meta": {"var": var},
            })

    if isinstance(env, dict):
        for k, v in env.items():
            if isinstance(v, str):
                _check_string(f"environment.{k}", v)

    # Issue #566 缺陷 #11:env-var-unresolved 必须扫 command / entrypoint / args
    # (redis: command: redis-server --requirepass ${CDS_REDIS_PASSWORD} 老规则会漏)
    for field_name in ("command", "entrypoint", "args"):
        val = svc.get(field_name)
        if isinstance(val, str):
            _check_string(field_name, val)
        elif isinstance(val, list):
            for idx, item in enumerate(val):
                if isinstance(item, str):
                    _check_string(f"{field_name}[{idx}]", item)
    return issues


# Bugbot fix(2026-05-04 PR #523):F13/F14 专用窄表 — 只匹配真 DB schema
# 初始化路径(mysql/postgres/mongodb 都用 `/docker-entrypoint-initdb.d/`)。
# 不复用上面的 `_INIT_SCRIPT_TARGET_PREFIXES`,那个为 `_is_app_source_mount`
# 设计,包含 `/etc/` `/usr/local/etc/` `/init/` 通用配置目录。如 redis.conf
# 挂到 `/etc/redis/` 不算 DB init script,但宽前缀会让 F14 误抑制 WARN +
# F13 误发 INFO。
_DB_INIT_SCRIPT_TARGET_PREFIXES = (
    "/docker-entrypoint-initdb.d/",
)


def _collect_init_script_mounts(infra_services: dict) -> list[tuple[str, str]]:
    """扫描所有 infra service,返回 (service_name, source_path) 列表 — 命中
    `/docker-entrypoint-initdb.d/` 这种 DB schema 初始化路径的本地挂载。

    用于 F13(verify INFO 提示)+ F14(`schemaful-db-no-migration` WARNING 抑制)。
    严格匹配 DB init 路径,不覆盖 `/etc/` 这类通用配置(redis.conf 等)。
    """
    out: list[tuple[str, str]] = []
    for svc_name, svc in infra_services.items():
        if not isinstance(svc, dict):
            continue
        vols = svc.get("volumes") or []
        if not isinstance(vols, list):
            continue
        for v in vols:
            if not isinstance(v, str):
                continue
            parts = v.split(":")
            if len(parts) < 2:
                continue
            source, target = parts[0], parts[1]
            if not (source.startswith("./") or source == "."):
                continue
            if any(target.startswith(t) for t in _DB_INIT_SCRIPT_TARGET_PREFIXES):
                out.append((svc_name, source))
    return out


def _is_schemaful_db_image(image_value: object) -> bool:
    """判断 docker image 是否是 schemaful DB(mysql/mariadb/postgres/sqlserver/oracle/db2)。"""
    if not isinstance(image_value, str):
        return False
    image_lower = image_value.lower()
    return any(kw in image_lower for kw in _SCHEMAFUL_DB_NAMES)


def _verify_schemaful_db_migration(infra_services: dict, app_services: dict) -> list[dict]:
    """WARNING:命中 schemaful DB 时,应用 command 应含 migration 关键词;但若
    *该 schemaful DB 自身* 已挂 init.sql 到 `/docker-entrypoint-initdb.d/` 也算
    "已自带 schema 引导",不再 WARN(F14 修复:demo 走 init.sql 不是 ORM 时被误报)。

    Bugbot fix(2026-05-04 PR #523 第五轮):之前 short-circuit 用
    `_collect_init_script_mounts(infra_services)` 扫了 *全部* infra,会出现
    「mysql 没 init,但 mongodb 有 init.js」也被当成 schemaful DB 已自带
    schema 的误判。现在按 service 名 → image 类型查表,只看 schemaful
    DB 自己有没有 init script。
    """
    schemaful_db_names = {
        name for name, svc in infra_services.items()
        if isinstance(svc, dict) and _is_schemaful_db_image(svc.get("image"))
    }
    if not schemaful_db_names:
        return []
    # 只取属于 schemaful DB 的 init mount(忽略 mongodb 等 schemaless DB 的 init.js)
    schemaful_db_init_mounts = [
        (svc_name, source)
        for svc_name, source in _collect_init_script_mounts(infra_services)
        if svc_name in schemaful_db_names
    ]
    if schemaful_db_init_mounts:
        return []
    issues: list[dict] = []
    for name, svc in app_services.items():
        cmd = svc.get("command") or ""
        if isinstance(cmd, list):
            cmd = " ".join(str(c) for c in cmd)
        cmd_lower = cmd.lower()
        if any(kw in cmd_lower for kw in _MIGRATION_KEYWORDS):
            continue
        issues.append({
            "severity": "WARNING",
            "service": name,
            "rule": "schemaful-db-no-migration",
            "message": f"项目含 schemaful DB(MySQL/Postgres/SQL Server),但应用 {name}.command 不含 migration 关键词,且 schemaful DB 自身未挂 init script",
            "fix": "二选一:(a) 在 command 前缀加 ORM migration 命令,如 prisma migrate deploy / dotnet ef database update / npm run migration:run;或 (b) 把建表脚本挂到 mysql/postgres 的 /docker-entrypoint-initdb.d/init.sql",
        })
    return issues


def _verify_init_script_ack(infra_services: dict) -> list[dict]:
    """INFO:扫描到 init script 挂载时给出确认提示(F13)。

    背景:用户在 mysql/postgres demo 里挂 `./init.sql:/docker-entrypoint-initdb.d/init.sql`
    走 schema 初始化,verify 只在 _verify_schemaful_db_migration 静默接受这个事实,
    用户看不到 cdscli 已经识别。F13 加 INFO 让"我知道你挂了 init.sql"显式可见。
    """
    mounts = _collect_init_script_mounts(infra_services)
    if not mounts:
        return []
    # 同 service 多脚本聚合成一行
    by_svc: dict[str, list[str]] = {}
    for svc_name, source in mounts:
        by_svc.setdefault(svc_name, []).append(source)
    issues: list[dict] = []
    for svc_name in sorted(by_svc):
        sources = sorted(set(by_svc[svc_name]))
        listing = ", ".join(sources)
        issues.append({
            "severity": "INFO",
            "service": svc_name,
            "rule": "infra-init-script-detected",
            "message": f"{svc_name} 已挂 init script: {listing} → /docker-entrypoint-initdb.d/(首次启动会执行,改脚本后需 reset data volume 才会重跑)",
            "fix": "无需修复;若想改 schema 后重跑,删除该 infra 的 data volume 后重 deploy",
        })
    return issues


def _verify_password_url_safety(env_decls: dict) -> list[dict]:
    """INFO:连接串 env 含密码引用,且 x-cds-env 里的密码值含未编码特殊字符。"""
    issues: list[dict] = []
    for k, v in env_decls.items():
        if not isinstance(v, str):
            continue
        # 启发式:连接串风格(含 ://)且含 ${VAR} 引用
        if "://" not in v or "${" not in v:
            continue
        # 找出引用的密码变量,看其值
        for var in _verify_extract_var_refs(v):
            ref_val = env_decls.get(var)
            if not isinstance(ref_val, str):
                continue
            if any(c in _URL_UNSAFE_CHARS for c in ref_val):
                issues.append({
                    "severity": "INFO",
                    "service": "x-cds-env",
                    "rule": "password-url-unsafe",
                    "message": f"x-cds-env.{k} 引用 ${{{var}}},而 {var} 含 URL 不安全字符({sorted(set(c for c in ref_val if c in _URL_UNSAFE_CHARS))})",
                    "fix": f"如果该变量出现在连接串中,可能需要 url-encode 或换密码;_gen_password 已改用 token_urlsafe 避免此问题",
                })
                break
    return issues


def _verify_dependsOn_hint(app_services: dict, infra_services: dict) -> list[dict]:
    """INFO:env 引用了 ${MONGODB_URL}/${DATABASE_URL}/${REDIS_URL} 但 dependsOn 不含对应 infra。
    Phase 2 兜底起 infra 后即使不写 dependsOn 也能跑,但显式声明仍利于自文档化。

    Bugbot fix(PR #521 第四轮):DATABASE_URL 不再硬编码 infra_id="mysql",
    根据本项目实际存在的 infra 动态选(postgres/mysql/mariadb 任一命中)→
    避免在 postgres 项目里 hint 文案误说"引用了 mysql 连接串"。"""
    # url_keys → 候选 infra(按优先级,本项目命中第一个就用)
    hint_map = [
        (["MONGODB_URL", "MONGO_URL", "CDS_MONGODB_URL"], ["mongodb"]),
        # DATABASE_URL 是通用名,可能是 mysql/mariadb/postgres,按 infra 实际存在的选
        (["DATABASE_URL", "CDS_DATABASE_URL"], ["postgres", "mysql", "mariadb"]),
        (["POSTGRES_URL", "CDS_POSTGRES_URL"], ["postgres"]),
        (["MYSQL_URL", "CDS_MYSQL_URL"], ["mysql", "mariadb"]),
        (["REDIS_URL", "CDS_REDIS_URL"], ["redis"]),
        (["AMQP_URL", "CDS_AMQP_URL"], ["rabbitmq"]),
        (["S3_ENDPOINT", "CDS_S3_ENDPOINT"], ["minio"]),
    ]
    issues: list[dict] = []
    infra_names = set(infra_services.keys())
    for app_name, svc in app_services.items():
        env = svc.get("environment") or {}
        if not isinstance(env, dict):
            continue
        deps_raw = svc.get("depends_on") or []
        deps = list(deps_raw.keys()) if isinstance(deps_raw, dict) else list(deps_raw)
        env_text = " ".join(str(v) for v in env.values())
        for url_keys, candidate_infras in hint_map:
            if not any(uk in env_text for uk in url_keys):
                continue
            # 在候选 infra 列表里挑本项目实际有的第一个,作为提示对象
            matched_infra = next((c for c in candidate_infras if c in infra_names), None)
            if matched_infra is None:
                continue
            # Bugbot fix(PR #521 第十三轮 Bug 1)— 只判断是否声明了**该 url 候选**
            # infra,不再用全量 declared_dep_aliases 一刀切。之前若 app 声明
            # depends_on:[redis] 就会把 postgres / mongo 等所有缺漏全部静音。
            # 现在 DATABASE_URL 命中的候选是 [postgres,mysql,mariadb],只要其中
            # 任一在 deps 里就不再 hint(声明 mysql 的项目用 DATABASE_URL 不算缺)。
            if any(c in deps for c in candidate_infras):
                continue
            issues.append({
                "severity": "INFO",
                "service": app_name,
                "rule": "depends-on-hint",
                "message": f"{app_name} environment 引用了 {matched_infra} 连接串,但 depends_on 没声明该 infra",
                "fix": f"考虑加 depends_on: [{matched_infra}](Phase 2 后即使不写也兜底自动起,但显式声明利于自文档化)",
                "meta": {"service": app_name, "infra": matched_infra},
            })
    return issues


def _verify_scan_signals(doc: dict) -> list[dict]:
    """Issue #566 缺陷 #9 / mdimp 缺陷 #5:读 x-cds-signals,把 scan 阶段的 partial /
    missingInfra / warnings / skippedComposeFiles 复盘成 verify 的 WARNING,
    防止 Agent 看到 verify=ok 误判可部署。
    """
    issues: list[dict] = []
    sig = doc.get("x-cds-signals")
    if not isinstance(sig, dict):
        return issues
    if sig.get("status") == "partial":
        reason = sig.get("partialReason") or "scan 阶段标记 partial"
        issues.append({
            "severity": "WARNING",
            "service": "(top-level)",
            "rule": "scan-status-partial",
            "message": f"scan 自评估为 partial: {reason}",
            "fix": "复核 x-cds-signals.warnings/missingInfra,补齐 infra 或人工确认后部署",
        })
    missing = sig.get("missingInfra") or []
    if isinstance(missing, list) and missing:
        issues.append({
            "severity": "WARNING",
            "service": "(top-level)",
            "rule": "scan-missing-infra",
            "message": f"后端检测到缺失 infra: {', '.join(str(x) for x in missing)}",
            "fix": "在 services 段补齐对应 infra 或在 CDS 复用共享 infra,然后重跑 scan",
        })
    warnings = sig.get("warnings") or []
    if isinstance(warnings, list):
        for w in warnings:
            issues.append({
                "severity": "WARNING",
                "service": "(top-level)",
                "rule": "scan-warning",
                "message": str(w),
            })
    skipped = sig.get("skippedComposeFiles") or []
    if isinstance(skipped, list) and skipped:
        issues.append({
            "severity": "INFO",
            "service": "(top-level)",
            "rule": "scan-skipped-compose",
            "message": f"scan 阶段未展开的 docker-compose: {', '.join(str(x) for x in skipped)}",
        })
    return issues


def _verify_run_all(doc: dict, root: str) -> list[dict]:
    services = doc.get("services") or {}
    if not isinstance(services, dict):
        return [{
            "severity": "ERROR",
            "service": "(top-level)",
            "rule": "services-section-missing",
            "message": "compose 文件 services 段缺失或不是 dict",
            "fix": "添加 services: 段并定义至少一个 service",
        }]
    env_keys = _verify_collect_env_keys(doc)
    env_decls = doc.get("x-cds-env") if isinstance(doc.get("x-cds-env"), dict) else {}
    app_services = {n: s for n, s in services.items() if isinstance(s, dict) and _verify_is_app_service(s)}
    infra_services = {n: s for n, s in services.items() if isinstance(s, dict) and not _verify_is_app_service(s)}

    issues: list[dict] = []
    # ERROR
    for name, svc in app_services.items():
        issues += _verify_app_workdir(name, svc, root)
        issues += _verify_app_ports(name, svc)
        issues += _verify_env_resolves(name, svc, env_keys)
    for name, svc in infra_services.items():
        issues += _verify_infra_image(name, svc)
        issues += _verify_env_resolves(name, svc, env_keys)
    # WARNING
    issues += _verify_schemaful_db_migration(infra_services, app_services)
    issues += _verify_scan_signals(doc)
    # INFO
    issues += _verify_init_script_ack(infra_services)
    issues += _verify_password_url_safety(env_decls)
    issues += _verify_dependsOn_hint(app_services, infra_services)
    return issues


# ── 评分(WS4)+ 自愈(WS5):SSOT doc/spec.cds-compose-contract.md § 4.4 / § 4.5 ──

# 每级严重度扣分。垃圾 compose(多 ERROR)分数被快速压到 F,挡在部署门外。
_VERIFY_SEVERITY_PENALTY = {"ERROR": 25, "WARNING": 8, "INFO": 2}
# 等级分档(score >= threshold → grade)。从高到低匹配。
_VERIFY_GRADE_BANDS = [(90, "A"), (75, "B"), (60, "C"), (40, "D"), (0, "F")]


def _verify_grade(score: int) -> str:
    for threshold, grade in _VERIFY_GRADE_BANDS:
        if score >= threshold:
            return grade
    return "F"


def _verify_score(issues: list[dict]) -> dict:
    """把 ERROR/WARNING/INFO 聚合成 0-100 评分 + 字母等级。

    SSOT:doc/spec.cds-compose-contract.md § 4.4。评分只看 issue 严重度,
    满分 100,逐条扣分,下限 0。等级用于教程示例与 CI 的质量门禁。
    """
    deductions = {sev: 0 for sev in _VERIFY_SEVERITY_PENALTY}
    for i in issues:
        sev = i.get("severity")
        if sev in _VERIFY_SEVERITY_PENALTY:
            deductions[sev] += _VERIFY_SEVERITY_PENALTY[sev]
    total = sum(deductions.values())
    score = max(0, 100 - total)
    return {
        "score": score,
        "grade": _verify_grade(score),
        "deductions": deductions,
    }


# ── 自愈 fixer 注册表 ──
# 只对"机器能确定地修对"的规则做自动修补;其余只给建议(复用 issue 的 fix 文案)。
# fixer 签名:fixer(doc: dict, issue: dict) -> str | None
#   返回人类可读的"我改了什么";返回 None 表示本条无法自动修(降级为建议)。


def _autofix_env_var_unresolved(doc: dict, issue: dict) -> str | None:
    """ERROR env-var-unresolved → 在 x-cds-env 补一个占位变量,让 ${VAR} 闭环解析。

    占位值是 CHANGE_ME,verify 会通过但**仍需人工填真值**——输出里会标注。
    """
    var = (issue.get("meta") or {}).get("var")
    if not var:
        return None
    env = doc.get("x-cds-env")
    if not isinstance(env, dict):
        env = {}
        doc["x-cds-env"] = env
    if var in env:
        # 同一次修复循环里已被前一条 issue 补入;视为已修,不降级为 manual。
        return f"x-cds-env 已含 {var}(同次修复,无需重复写入)"
    env[var] = "CHANGE_ME"
    return f"x-cds-env 新增 {var}: CHANGE_ME(占位,需人工改成真实值)"


def _autofix_depends_on_hint(doc: dict, issue: dict) -> str | None:
    """INFO depends-on-hint → 给应用 service 的 depends_on 补上引用到的 infra。"""
    meta = issue.get("meta") or {}
    svc_name, infra = meta.get("service"), meta.get("infra")
    if not svc_name or not infra:
        return None
    services = doc.get("services")
    if not isinstance(services, dict) or svc_name not in services:
        return None
    svc = services[svc_name]
    if not isinstance(svc, dict):
        return None
    deps = svc.get("depends_on")
    if isinstance(deps, dict):
        if infra in deps:
            return None
        deps[infra] = {"condition": "service_started"}
    else:
        if isinstance(deps, str):
            deps = [deps]
        elif not isinstance(deps, list):
            deps = []
        if infra in deps:
            return None
        deps.append(infra)
        svc["depends_on"] = deps
    return f"{svc_name}.depends_on 补上 {infra}"


# rule → (fixer, 是否需人工复核)。needsReview=True 表示自动修了但值是占位/需确认。
_AUTOFIX_RULES: dict[str, tuple] = {
    "env-var-unresolved": (_autofix_env_var_unresolved, True),
    "depends-on-hint": (_autofix_depends_on_hint, False),
}


def _verify_autofix(compose_path: str, doc: dict, issues: list[dict]) -> dict:
    """对可自愈的 issue 逐条修补 doc,产出 patched YAML + diff + 建议清单。

    返回 {autoFixed: [...], needsReview: bool, manual: [...], patchedYaml, diff}。
    不落盘——是否写文件由调用方按 --write 决定。
    """
    import copy as _copy
    import difflib as _difflib
    try:
        import yaml  # type: ignore
    except ImportError:
        die("verify --fix 需要 PyYAML", code=4)

    with open(compose_path, "r", encoding="utf-8") as f:
        original_text = f.read()

    patched = _copy.deepcopy(doc)
    auto_fixed: list[dict] = []
    needs_review = False
    manual: list[dict] = []

    for issue in issues:
        rule = issue.get("rule")
        entry = _AUTOFIX_RULES.get(rule) if rule else None
        if entry is None:
            # 不可自动修 → 收进建议清单
            manual.append({
                "severity": issue.get("severity"),
                "service": issue.get("service"),
                "rule": rule,
                "message": issue.get("message"),
                "fix": issue.get("fix"),
            })
            continue
        fixer, review = entry
        desc = fixer(patched, issue)
        if desc is None:
            # fixer 放弃(信息不足)→ 也降级为建议
            manual.append({
                "severity": issue.get("severity"),
                "service": issue.get("service"),
                "rule": rule,
                "message": issue.get("message"),
                "fix": issue.get("fix"),
            })
            continue
        auto_fixed.append({"rule": rule, "service": issue.get("service"), "applied": desc})
        if review:
            needs_review = True

    patched_text = yaml.safe_dump(
        patched, sort_keys=False, default_flow_style=False, allow_unicode=True
    )
    diff = "".join(_difflib.unified_diff(
        original_text.splitlines(keepends=True),
        patched_text.splitlines(keepends=True),
        fromfile=os.path.basename(compose_path),
        tofile=os.path.basename(compose_path) + " (patched)",
    ))
    return {
        "autoFixed": auto_fixed,
        "needsReview": needs_review,
        "manual": manual,
        "patchedYaml": patched_text,
        "diff": diff,
    }


def cmd_verify(args: argparse.Namespace) -> None:
    """校验 cds-compose 文件:三级严重度(ERROR / WARNING / INFO)分级输出 + 评分 + 自愈。

    退出码:
      0 — 无 ERROR 且(若指定)score >= --min-score(可能含 WARNING/INFO,部署多半能跑)
      1 — 至少一个 ERROR,或 score < --min-score(质量门禁未过)
      2 — 解析失败 / yaml 不合法 / 文件找不到
      4 — 缺 PyYAML 等环境问题

    支持直接传入文件路径（如 cdscli verify cds-comose.yml）。
    可选 flag:
      --min-score N   评分 < N 时 exit 1(垃圾 compose 门禁)
      --fix           输出自愈修补(diff + 建议),不落盘
      --write         配合 --fix,把修补写回文件(先备份 .bak)
    校验规则 SSOT:doc/spec.cds-compose-contract.md § 4。
    """
    target = os.path.abspath(args.path or ".")

    # 支持直接传文件路径（如 cds-comose.yml）
    if os.path.isfile(target):
        root = os.path.dirname(target)
        explicit_file = target
    else:
        root = target
        explicit_file = None
        if not os.path.isdir(root):
            die(f"目录不存在: {root}", code=2)

    found = _verify_load_compose(root, explicit_file=explicit_file)
    if not found:
        die(f"未在 {root} 找到 cds-compose.yml / docker-compose.yml(等);先跑 cdscli scan", code=2)
    compose_path, doc = found

    issues = _verify_run_all(doc, root)
    summary = {
        "errors":   sum(1 for i in issues if i["severity"] == "ERROR"),
        "warnings": sum(1 for i in issues if i["severity"] == "WARNING"),
        "infos":    sum(1 for i in issues if i["severity"] == "INFO"),
    }
    score = _verify_score(issues)
    summary["score"] = score["score"]
    summary["grade"] = score["grade"]

    payload: dict[str, Any] = {
        "composeFile": os.path.relpath(compose_path, root),
        "issues": issues,
        "summary": summary,
    }

    # ── 自愈(--fix) — 先在内存中计算 patch,不落盘 ──
    heal: dict | None = None
    if getattr(args, "fix", False):
        heal = _verify_autofix(compose_path, doc, issues)
        payload["heal"] = {
            "autoFixed": heal["autoFixed"],
            "needsReview": heal["needsReview"],
            "manual": heal["manual"],
            "diff": heal["diff"],
            "written": False,
        }

    # ── 质量门禁:ERROR 或 score 不达标 ──
    # 若 --fix --write 请求且有可自愈项,先按修复后剩余 issue 评分,再决定是否写盘。
    # 这样保证:门禁失败时磁盘不被改动;门禁通过后再落盘并用修复后状态作为输出。
    gate_summary = summary
    gate_score = score
    remaining: list[dict] = issues  # 默认指向原始列表
    will_write = (heal is not None and getattr(args, "write", False)
                  and bool(heal["autoFixed"]))
    if will_write:
        fixed_counter: dict = {}
        for fx in heal["autoFixed"]:  # type: ignore[index]
            k = (fx.get("rule"), fx.get("service"))
            fixed_counter[k] = fixed_counter.get(k, 0) + 1
        remaining = []
        pending = dict(fixed_counter)
        for iss in issues:
            k = (iss.get("rule"), iss.get("service"))
            if pending.get(k, 0) > 0:
                pending[k] -= 1
            else:
                remaining.append(iss)
        gate_score = _verify_score(remaining)
        gate_summary = {
            "errors":   sum(1 for i in remaining if i["severity"] == "ERROR"),
            "warnings": sum(1 for i in remaining if i["severity"] == "WARNING"),
            "infos":    sum(1 for i in remaining if i["severity"] == "INFO"),
        }
        gate_summary["score"] = gate_score["score"]
        gate_summary["grade"] = gate_score["grade"]

    min_score = getattr(args, "min_score", None)
    gate_fail = gate_summary["errors"] > 0 or (min_score is not None and gate_score["score"] < min_score)
    if gate_fail:
        reasons = []
        if gate_summary["errors"] > 0:
            reasons.append(f"{gate_summary['errors']} 个 ERROR")
        if min_score is not None and gate_score["score"] < min_score:
            reasons.append(f"评分 {gate_score['score']}(等级 {gate_score['grade']})< 门槛 {min_score}")
        die("verify 未过门禁: " + ", ".join(reasons), code=1, extra=payload)

    # ── 门禁通过后才落盘 ──
    if will_write:
        backup = compose_path + ".bak"
        try:
            with open(compose_path, "r", encoding="utf-8") as f:
                with open(backup, "w", encoding="utf-8") as b:
                    b.write(f.read())
            with open(compose_path, "w", encoding="utf-8") as f:
                f.write(heal["patchedYaml"])  # type: ignore[index]
            payload["heal"]["written"] = True  # type: ignore[index]
            payload["heal"]["backup"] = os.path.relpath(backup, root)  # type: ignore[index]
        except OSError as e:
            die(f"写回 {compose_path} 失败: {e}", code=2, extra=payload)
        # 用修复后状态更新 payload 顶层字段,使解析方读到一致的输出
        payload["issues"] = remaining
        payload["summary"] = gate_summary

    note = (f"verify 通过 评分={gate_score['score']}({gate_score['grade']}) "
            f"WARNING={gate_summary['warnings']} INFO={gate_summary['infos']}")
    ok(payload, note=note)


def _walk(root: str, depth: int = 2) -> list[str]:
    """轻量遍历，避免 node_modules 污染。"""
    out: list[str] = []
    for cur, dirs, files in os.walk(root):
        rel = os.path.relpath(cur, root)
        if rel.count(os.sep) >= depth:
            dirs.clear()
            continue
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "dist", "bin", "obj")]
        out.extend(os.path.join(rel, f) for f in files)
    return out


def cmd_smoke(args: argparse.Namespace) -> None:
    """分层冒烟：L1 预览域根路径 / L2 version-check / L3 认证 API。

    预览域名走 `/api/branches` 的 previewSlug 字段（v3 SSOT，由后端
    `cds/src/services/preview-slug.ts:computePreviewSlug` 唯一生成）。
    历史踩坑：曾用 `f"https://{branch_id}.miduo.org"` v1 公式，在多项目
    CDS 下不可用——此处永久废弃该写法。
    """
    branch_id = args.id
    root = _preview_root_from_host()
    # 优先查 API 拿 v3 previewSlug；查不到才回退裸 id 模式（伴随 stderr 警告）。
    # 用 _call_safe 收口所有失败（含网络错误），避免 _request.die() 污染 stdout。
    # `_call_safe → _cds_base()` 在 CDS_HOST 未设时也会 die；smoke 本意是即使
    # 没 CDS API 凭据也能跑分层探测，所以前置检查跳过 API 查询，preview_slug
    # 保持 branch_id（裸 id fallback，与 "未返回 previewSlug" 行为一致）。
    preview_slug = branch_id
    if os.environ.get("CDS_HOST", "").strip():
        body = _call_safe("GET", "/api/branches", timeout=30)
        api_failed = _warn_quiet_call_error(body, "拉 /api/branches")
        # 2xx 非 JSON 响应（代理 / WAF 返回 HTML 错误页 200 等）必须显式警告，
        # 不能静默把 body 当空 branches 走 canonical-id-as-host 探测——CDS proxy
        # 不按 canonical id 路由，L1-L3 全失败但误导成 smoke 自己的问题，
        # 掩盖真正的 proxy 故障。与 cmd_preview_url 对齐。
        if not api_failed and not isinstance(body, dict):
            print(f"[warn] /api/branches 返回非 JSON 响应"
                  f"（type={type(body).__name__}），可能 CDS proxy 异常；"
                  f"smoke 仍继续但用裸 id 拼预览域（探测结果可能误导）",
                  file=sys.stderr)
            api_failed = True
        if not api_failed:
            # `body.get("branches", [])` 在 "branches": null 时返回 None；统一
            # `or []` 兜底，下面 for 迭代不再 TypeError。同时过滤非 dict 元素，
            # 防 `[null]` / 混合类型让 .get() AttributeError 给 traceback。
            raw = (body.get("branches") or []) if isinstance(body, dict) else []
            branches = [x for x in raw if isinstance(x, dict)]
            matched = False
            for b in branches:
                if b.get("id") == branch_id:
                    slug = b.get("previewSlug")
                    if not slug:
                        # canonical id ≠ v3 previewSlug，拼出来的 host CDS proxy
                        # 不会响应，L1-L3 全失败且无意义。与 cmd_branch_preview_url
                        # 行为对齐：服务端返回不完整 → 明确 die，不静默退化。
                        die(f"/api/branches 匹配到 '{branch_id}' 但缺 previewSlug "
                            f"字段。CDS 版本过旧或后端 bug，请升级 CDS 或检查 "
                            f"cds/src/routes/branches.ts",
                            code=3, extra={"branch": b})
                        return
                    preview_slug = slug
                    matched = True
                    break
            if not matched:
                # API 成功但未匹配到该 branch_id —— canonical id ≠ v3 previewSlug，
                # 用裸 branch_id 拼预览域会指向 CDS proxy 不路由的 host，L1-L3 全
                # 失败但用户被误导以为 smoke 自己有问题。与其它 fallback 路径对齐
                # 显式 stderr warning，让用户能感知"被探测的 host 不是 v3 正解"。
                print(f"[warn] /api/branches 没找到 branch id '{branch_id}'，"
                      f"smoke 仍继续但用裸 id 拼预览域（探测结果可能误导；"
                      f"先 /cds-deploy 或检查 id 是否正确）",
                      file=sys.stderr)
    else:
        print(f"[warn] CDS_HOST 未设，smoke 跳过 API 查询，用裸 id 拼预览域",
              file=sys.stderr)
    preview = f"https://{preview_slug}.{root}"
    results: list[dict[str, Any]] = []

    def probe(name: str, url: str, headers: dict[str, str] | None = None,
              expect_status: int = 200) -> dict[str, Any]:
        req = urllib.request.Request(url, method="GET",
                                     headers={"User-Agent": "curl/8.5.0", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()[:200].decode("utf-8", errors="replace")
                return {"layer": name, "url": url, "status": r.status,
                        "pass": r.status == expect_status,
                        "preview": raw[:120]}
        except urllib.error.HTTPError as e:
            return {"layer": name, "url": url, "status": e.code,
                    "pass": e.code == expect_status, "error": e.reason}
        except Exception as e:
            return {"layer": name, "url": url, "status": 0, "pass": False,
                    "error": str(e)[:80]}

    # L1 根路径无认证
    results.append(probe("L1-root", f"{preview}/"))
    # L2 无认证 API (常见路径)
    for path in ("/api/shortcuts/version-check", "/healthz", "/api/health"):
        r = probe(f"L2{path}", f"{preview}{path}")
        results.append(r)
        if r["pass"]:
            break
    # L3 认证 API
    key = os.environ.get("AI_ACCESS_KEY", "")
    user = os.environ.get("MAP_AI_USER", "")
    if key:
        hdrs = {"X-AI-Access-Key": key}
        if user:
            hdrs["X-AI-Impersonate"] = user
        results.append(probe("L3-authed", f"{preview}/api/users?pageSize=1",
                             headers=hdrs, expect_status=200))

    passed = sum(1 for r in results if r["pass"])
    summary = {"branchId": branch_id, "preview": preview,
               "passed": f"{passed}/{len(results)}", "probes": results}
    if passed == len(results):
        ok(summary, note=f"冒烟全绿 ({passed}/{len(results)})")
    die(f"冒烟失败 ({passed}/{len(results)} 通过)", code=2, extra={"data": summary})


def cmd_help_me_check(args: argparse.Namespace) -> None:
    """diagnose + 根因模式匹配 + 修复建议。"""
    # 先跑 diagnose
    import io as _io
    import contextlib as _ctx
    buf = _io.StringIO()
    ns = argparse.Namespace(id=args.id, tail=120, max_profiles=4)
    with _ctx.redirect_stdout(buf):
        try:
            cmd_diagnose(ns)
        except SystemExit:
            pass
    try:
        payload = json.loads(buf.getvalue())
    except (json.JSONDecodeError, ValueError):
        die("diagnose 输出无法解析", code=3)
    data = payload.get("data", {})

    # 根因模式匹配
    patterns = [
        (r"error CS\d+", "C# 编译错误", "本地 `dotnet build --no-restore` 复现，按行号修改后重新 push"),
        (r"connection refused", "下游服务拒接", "检查 infra 服务（MongoDB/Redis）是否 running: cdscli branch status <id>"),
        (r"ENOENT.*node_modules", "前端依赖缺失", "容器里跑 pnpm install 或重新触发 deploy"),
        (r"port \d+ already in use", "端口冲突", "POST /api/cleanup-orphans 清理孤儿容器"),
        (r"EACCES|permission denied", "权限问题", "检查挂载卷的 owner 和容器 user"),
        (r"OutOfMemory|OOMKilled", "OOM", "提升容器内存或优化启动内存占用"),
        (r"timeout.*exceeded|ETIMEDOUT", "超时", "检查外部依赖（LLM / 第三方 API）是否可达"),
        (r"Invalid.*token|401 Unauthorized|未授权", "认证失败", "检查 AI_ACCESS_KEY / 用户映射，参考 reference/auth.md 决策树"),
    ]
    import re as _re
    findings: list[dict[str, str]] = []
    all_logs = "\n".join((data.get("logs") or {}).values())
    for pat, cause, fix in patterns:
        if _re.search(pat, all_logs, _re.IGNORECASE):
            findings.append({"pattern": pat, "cause": cause, "suggestion": fix})
    data["findings"] = findings
    data["rootCause"] = findings[0] if findings else {"cause": "未命中已知模式",
                                                       "suggestion": "人工查看 logs/<profile> 字段"}
    ok(data, note=f"诊断+分析完成 (匹配 {len(findings)} 个已知模式)")


def cmd_sync_from_cds(args: argparse.Namespace) -> None:
    """维护者专用：诊断 cds/src/routes/*.ts 和 CLI+reference 之间的端点漂移。

    路径解析优先级（覆盖 CDS 未来独立仓库的场景）：
      1. --routes-dir <path>            命令行显式
      2. $CDS_ROUTES_DIR                  环境变量
      3. git rev-parse + cds/src/routes   假设 CDS 还在 monorepo 里
      4. 相对 cli 文件的历史推断           兜底
      任一存在且是目录即采用，否则给出清晰指引，拒绝扫描。

    不会跨到其它项目（prd-api / prd-admin 等）——只看给定目录下 .ts 文件。
    """
    import re
    import subprocess as _sp

    # 1. 路径解析
    routes_dir = (getattr(args, "routes_dir", None) or "").strip() \
        or os.environ.get("CDS_ROUTES_DIR", "").strip()

    if not routes_dir:
        # 2. 尝试 git rev-parse --show-toplevel + cds/src/routes
        try:
            git_root = _sp.check_output(
                ["git", "rev-parse", "--show-toplevel"],
                stderr=_sp.DEVNULL, text=True, timeout=5,
            ).strip()
            candidate = os.path.join(git_root, "cds", "src", "routes")
            if os.path.isdir(candidate):
                routes_dir = candidate
        except (_sp.SubprocessError, FileNotFoundError, OSError):
            pass

    if not routes_dir:
        # 3. 兜底：从 cli 文件反推（假设还在 .claude/skills/cds/cli/ 结构下）
        cli_path = os.path.abspath(__file__)
        skill_root = os.path.dirname(os.path.dirname(cli_path))
        claude_root = os.path.dirname(os.path.dirname(skill_root))
        repo_root = os.path.dirname(claude_root)
        candidate = os.path.join(repo_root, "cds", "src", "routes")
        if os.path.isdir(candidate):
            routes_dir = candidate

    if not routes_dir or not os.path.isdir(routes_dir):
        die(
            "未找到 CDS routes 目录。sync-from-cds 仅维护者使用。\n"
            "解决办法（任选一种）：\n"
            "  1. 在 prd_agent（或 CDS 独立仓库）根目录跑此命令\n"
            "  2. cdscli sync-from-cds --routes-dir /path/to/cds/src/routes\n"
            "  3. export CDS_ROUTES_DIR=/path/to/cds/src/routes",
            code=1)

    # stderr 打印实际扫描路径，避免"它到底扫了哪"的疑问
    if not getattr(args, "quiet", False):
        print(f"[sync-from-cds] 扫描路径: {routes_dir}", file=sys.stderr)

    cli_path = os.path.abspath(__file__)
    skill_root = os.path.dirname(os.path.dirname(cli_path))
    api_doc = os.path.join(skill_root, "reference", "api.md")

    def norm(p: str) -> str:
        return re.sub(r":\w+", ":X", p.split("?")[0])

    ep_re = re.compile(r"""router\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]""")
    cds_endpoints: set[tuple[str, str]] = set()
    scanned_files: list[str] = []
    for fn in sorted(os.listdir(routes_dir)):
        if not fn.endswith(".ts"):
            continue
        scanned_files.append(fn)
        with open(os.path.join(routes_dir, fn), encoding="utf-8") as f:
            src = f.read()
        for m in ep_re.finditer(src):
            method = m.group(1).upper()
            path = m.group(2)
            if not path.startswith("/"):
                continue
            full = path if path.startswith("/api") else "/api" + path
            cds_endpoints.add((method, full))

    with open(cli_path, encoding="utf-8") as f:
        cli_src = f.read()
    call_re = re.compile(
        r"""_(?:call|request)\(\s*["'](GET|POST|PUT|DELETE|PATCH)["']\s*,\s*f?["']"""
        r"""(/api/[^"'\s{}?]+)""", re.IGNORECASE,
    )
    cli_endpoints: set[tuple[str, str]] = set()
    for m in call_re.finditer(cli_src):
        cli_endpoints.add((m.group(1).upper(), m.group(2)))
    fstr_re = re.compile(
        r"""_(?:call|request)\(\s*["'](GET|POST|PUT|DELETE|PATCH)["']\s*,\s*f["'](/api/[^"']+?)["']""",
        re.IGNORECASE,
    )
    for m in fstr_re.finditer(cli_src):
        method = m.group(1).upper()
        path = re.sub(r"\{[^}]+\}", ":X", m.group(2))
        cli_endpoints.add((method, path))

    doc_endpoints: set[tuple[str, str]] = set()
    if os.path.exists(api_doc):
        with open(api_doc, encoding="utf-8") as f:
            for line in f:
                m = re.search(
                    r"\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`?(/api/[^\s|`]+)",
                    line,
                )
                if m:
                    doc_endpoints.add((m.group(1).upper(), m.group(2)))

    cds_n = {(m, norm(p)) for m, p in cds_endpoints}
    cli_n = {(m, norm(p)) for m, p in cli_endpoints}
    doc_n = {(m, norm(p)) for m, p in doc_endpoints}

    new_in_cds = sorted(cds_n - cli_n - doc_n)
    missing_in_cli = sorted(cds_n - cli_n)
    missing_in_docs = sorted(cds_n - doc_n)
    removed_from_cds = sorted((cli_n | doc_n) - cds_n)

    def fmt(pairs: list[tuple[str, str]]) -> list[str]:
        return [f"{m} {p}" for m, p in pairs]

    suggestions: list[str] = []
    if missing_in_cli:
        suggestions.append(
            f"在 cli/cdscli.py 增加 {len(missing_in_cli)} 个命令封装：每个端点加 "
            f"cmd_xxx(args) + _build_parser() 挂 subparser")
    if missing_in_docs:
        suggestions.append(
            f"在 reference/api.md 相应分组表格补 {len(missing_in_docs)} 行")
    if removed_from_cds:
        suggestions.append(
            f"[WARN] CLI/docs 里 {len(removed_from_cds)} 个端点在 CDS 已删除，"
            f"删 CLI 命令 or 标 DEPRECATED")
    if missing_in_cli or missing_in_docs or removed_from_cds:
        suggestions.append("改完 bump cdscli.py 的 VERSION + 加 changelog 碎片")
    if not suggestions:
        suggestions.append("[OK] CDS / CLI / docs 三边同步，无需更新")

    ok({
        "routesDir": routes_dir,
        "scannedFiles": scanned_files,
        "scanned": {
            "cdsEndpoints": len(cds_endpoints),
            "cliEndpoints": len(cli_endpoints),
            "docEndpoints": len(doc_endpoints),
        },
        "newInCds": fmt(new_in_cds),
        "missingInCli": fmt(missing_in_cli),
        "missingInDocs": fmt(missing_in_docs),
        "removedFromCds": fmt(removed_from_cds),
        "suggestions": suggestions,
        "driftCount": len(missing_in_cli) + len(missing_in_docs) + len(removed_from_cds),
    }, note=f"drift={len(missing_in_cli) + len(missing_in_docs) + len(removed_from_cds)} "
           f"(scanned {len(scanned_files)} files → CDS={len(cds_endpoints)} "
           f"CLI={len(cli_endpoints)} docs={len(doc_endpoints)})")


def cmd_version(args: argparse.Namespace) -> None:
    """显示本地 VERSION + buildTime + manifest，并对比服务端最新 VERSION。

    输出（JSON）字段：
      version       本地 VERSION 字符串
      buildTime     cdscli.py 文件 mtime 的 ISO 时间戳（无网调用，恒可用）
      gitSha        从 cds-skill-manifest.json 读 commit SHA；不可用 → "unknown"
      manifest      同目录 cds-skill-manifest.json 完整内容（缺则 null）
      remote        服务端 /api/cli-version 返回（可达时）；离线 → null
      status        local vs remote: latest / stale / ahead / unknown
    """
    import datetime
    local = VERSION
    cli_path = os.path.abspath(__file__)

    # buildTime 取 file mtime（最便宜的"构建时间"近似）
    build_time: str
    try:
        mtime = os.path.getmtime(cli_path)
        build_time = datetime.datetime.fromtimestamp(
            mtime, tz=datetime.timezone.utc
        ).isoformat()
    except OSError:
        build_time = "unknown"

    # manifest 同目录 cds-skill-manifest.json，可缺
    manifest: dict[str, Any] | None = None
    git_sha: str = "unknown"
    manifest_path = os.path.join(os.path.dirname(cli_path),
                                 "cds-skill-manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            if isinstance(manifest, dict):
                git_sha = (manifest.get("gitSha")
                           or manifest.get("git_sha")
                           or manifest.get("commit")
                           or "unknown")
        except (OSError, ValueError, json.JSONDecodeError):
            manifest = None  # 损坏的 manifest 视作不存在，不抛错

    # 远端版本（可选，离线时静默 fallback —— version 必须能离线运行）
    remote: str | None = None
    host = os.environ.get("CDS_HOST", "").strip()
    if host:
        # 直接做 HTTP 而非走 _request()：_request 在 URLError 时会 die() 退出，
        # version 命令需要在 CDS 不可达时仍能输出本地信息
        try:
            base = _cds_base()
            req = urllib.request.Request(
                base + "/api/cli-version",
                headers={"Accept": "application/json", **_auth_headers()},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                body = json.loads(raw) if raw else {}
                if isinstance(body, dict):
                    remote = body.get("version")
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError, socket.timeout, OSError, ValueError,
                json.JSONDecodeError, SystemExit):
            remote = None

    status_label = "unknown"
    if remote:
        cmp = _version_compare(local, remote)
        if cmp < 0:
            status_label = "stale"
        elif cmp == 0:
            status_label = "latest"
        else:
            status_label = "ahead"

    payload = {
        "version": local,
        "buildTime": build_time,
        "gitSha": git_sha,
        "manifest": manifest,
        "remote": remote,
        "status": status_label,
    }
    note = f"local={local} build={build_time[:19]}Z remote={remote or '?'} ({status_label})"
    if status_label == "stale":
        note += "  → 运行 `cdscli update` 升级"
    ok(payload, note=note)


def _version_compare(a: str, b: str) -> int:
    """语义版本比较。a<b 返 -1, 等 0, a>b 返 1。"""
    def parse(v: str) -> tuple[int, ...]:
        return tuple(int(x) for x in (v or "0").split(".") if x.isdigit())
    pa, pb = parse(a), parse(b)
    # 补齐长度
    m = max(len(pa), len(pb))
    pa = pa + (0,) * (m - len(pa))
    pb = pb + (0,) * (m - len(pb))
    return (pa > pb) - (pa < pb)


def cmd_update(args: argparse.Namespace) -> None:
    """自升级：从 /api/export-skill 拉最新 tar.gz，原地替换本技能目录。

    步骤：
      1. 定位当前技能根（cli/cdscli.py 的父父目录）
      2. 下载 tar.gz 到临时目录
      3. 整颗技能目录备份到 <root>.bak.<timestamp>（失败回滚用）
      4. 解压 tar.gz，从里面的 .claude/skills/cds/ 同步到当前根
      5. 用户自定义的非 tracked 文件（如用户本地脚本）保留不动

    不动：~/.cdsrc / 项目 .cds.env / 任何外部配置
    """
    import tempfile
    import shutil
    import tarfile
    import io as _io

    cli_path = os.path.abspath(__file__)
    cli_dir = os.path.dirname(cli_path)            # .../cds/cli
    skill_root = os.path.dirname(cli_dir)          # .../cds
    if os.path.basename(skill_root) != "cds":
        die(f"cdscli.py 不在期望的 .claude/skills/cds/cli/ 位置（实际: {cli_path}）。"
            f"请用 Dashboard 的 (zip) 按钮重新下载完整包。", code=1)

    # 1. 下载
    url = _cds_base() + "/api/export-skill"
    req = urllib.request.Request(url, headers=_auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            tar_bytes = resp.read()
    except urllib.error.HTTPError as e:
        die(f"下载失败 HTTP {e.code}: {e.read().decode('utf-8','replace')[:200]}", code=2)
    except (urllib.error.URLError, TimeoutError) as e:
        die(f"下载失败（网络）: {e}", code=1)
    if len(tar_bytes) < 100:
        die(f"下载内容过短（{len(tar_bytes)} bytes），疑似失败", code=3)

    # 2. 备份当前技能目录
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak_root = f"{skill_root}.bak.{ts}"
    try:
        shutil.copytree(skill_root, bak_root)
    except Exception as e:
        die(f"备份失败: {e}", code=3)

    # 3. 解压到临时目录
    tmp_dir = tempfile.mkdtemp(prefix="cdscli-update-")
    try:
        with tarfile.open(fileobj=_io.BytesIO(tar_bytes), mode="r:gz") as tar:
            # 安全解压：拒绝 .. / 绝对路径
            safe_members: list[tarfile.TarInfo] = []
            for m in tar.getmembers():
                if m.name.startswith("/") or ".." in m.name.split("/"):
                    continue
                safe_members.append(m)
            tar.extractall(tmp_dir, members=safe_members)

        # 4. 找到解压内的 .claude/skills/cds/
        src_cds_dir = None
        for root, dirs, _files in os.walk(tmp_dir):
            if root.endswith(os.path.join(".claude", "skills", "cds")):
                src_cds_dir = root
                break
        if not src_cds_dir:
            die("tar.gz 内找不到 .claude/skills/cds/ 结构。升级失败（已保留备份）。",
                code=3, extra={"backupAt": bak_root})

        # 5. 用内容同步：遍历 src 下所有路径，强制覆盖 dst
        replaced_files: list[str] = []
        for root, dirs, files in os.walk(src_cds_dir):
            rel = os.path.relpath(root, src_cds_dir)
            target_root = os.path.join(skill_root, rel) if rel != "." else skill_root
            os.makedirs(target_root, exist_ok=True)
            for d in dirs:
                os.makedirs(os.path.join(target_root, d), exist_ok=True)
            for f in files:
                src_f = os.path.join(root, f)
                dst_f = os.path.join(target_root, f)
                shutil.copy2(src_f, dst_f)
                replaced_files.append(os.path.relpath(dst_f, skill_root))
    except Exception as e:
        # 出错了，回滚
        try:
            shutil.rmtree(skill_root, ignore_errors=True)
            shutil.move(bak_root, skill_root)
        except Exception as rollback_err:
            die(f"升级失败且回滚也失败！请手动 `mv {bak_root} {skill_root}` "
                f"（原错: {e}; 回滚错: {rollback_err}）", code=3)
        die(f"升级失败，已自动回滚: {e}", code=3)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    ok({
        "skillRoot": skill_root,
        "backupAt": bak_root,
        "filesReplaced": len(replaced_files),
        "sample": replaced_files[:8],
    }, note=f"升级完成。备份在 {bak_root}。确认一切正常后可 rm -rf 该备份。"
            f" 异常时回滚: rm -rf {skill_root} && mv {bak_root} {skill_root}")


def cmd_deploy(args: argparse.Namespace) -> None:
    """完整流水线：git push + CDS pull + deploy + ready wait + smoke。"""
    import subprocess
    # 1. 当前分支
    try:
        branch = subprocess.check_output(["git", "branch", "--show-current"],
                                         text=True).strip()
    except subprocess.CalledProcessError:
        die("git 仓库未检出", code=1)
    if branch in ("main", "master"):
        die(f"禁止在 {branch} 上部署", code=1)
    branch_id = _resolve_deploy_branch_id(branch)

    # 2. git push
    print(f"[1/4] git push origin {branch}", file=sys.stderr)
    rv = subprocess.run(["git", "push", "-u", "origin", branch],
                        capture_output=True, text=True)
    if rv.returncode != 0:
        die(f"git push 失败: {rv.stderr[:200]}", code=1)

    # 3. CDS pull
    print(f"[2/4] CDS pull branch={branch_id} (git={branch})", file=sys.stderr)
    _call("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/pull", timeout=60)

    # 4. Deploy (use the same trigger-safe behavior as `branch deploy`)
    print(f"[3/4] CDS deploy (timeout={args.timeout}s)", file=sys.stderr)
    trigger = _request_stream_safe("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/deploy", timeout=5)
    trigger_status = trigger.get("status")
    trigger_http_error = isinstance(trigger_status, int) and trigger_status >= 400
    if trigger_http_error or (not trigger["triggered"] and not str(trigger.get("error") or "").startswith("timeout_")):
        trigger_error = trigger.get("error") or (f"http_{trigger_status}" if trigger_status is not None else "unknown")
        die(f"deploy 触发失败: {trigger_error}",
            code=2 if trigger_status and trigger_status < 500 else 3,
            extra={
                "data": {
                    "stage": "deploy_trigger_failed",
                    "branchId": branch_id,
                    "triggerStatus": trigger_status,
                    "triggerBody": trigger.get("body"),
                    "triggerError": trigger.get("error"),
                    "errorType": trigger.get("errorType"),
                    "partial": trigger.get("partial", False),
                },
            })
        return
    if not trigger["triggered"]:
        print(f"[3/4] CDS deploy trigger not confirmed ({trigger.get('error')}); polling branch status", file=sys.stderr)
    time.sleep(3)
    deadline = time.time() + args.timeout
    final_status = None
    while time.time() < deadline:
        body = _call("GET", "/api/branches", timeout=30, quiet=True)
        if isinstance(body, dict) and body.get("__error__"):
            time.sleep(5)
            continue
        for b in body.get("branches", []):
            if b.get("id") == branch_id:
                st = b.get("status")
                if st in ("running", "error"):
                    final_status = st
                    break
        if final_status:
            break
        time.sleep(5)
    if final_status == "error":
        die(f"deploy 失败 branchId={branch_id}", code=2,
            extra={"hint": f"cdscli help-me-check {branch_id}"})
    if final_status != "running":
        die(
            f"deploy 轮询超时 branchId={branch_id}",
            code=2,
            extra={
                "data": {
                    "stage": "deploy_poll_timeout",
                    "branchId": branch_id,
                    "timeout": args.timeout,
                    "lastStatus": final_status,
                },
                "hint": f"cdscli help-me-check {branch_id}",
            },
        )

    # 5. Smoke (skip on --no-smoke)
    if not args.no_smoke:
        print(f"[4/4] Smoke test", file=sys.stderr)
        ns = argparse.Namespace(id=branch_id)
        try:
            cmd_smoke(ns)
        except SystemExit as e:
            if e.code != 0:
                die("smoke 失败", code=2,
                    extra={"hint": f"cdscli smoke {branch_id}"})
    ok({"branch": branch, "branchId": branch_id, "status": final_status},
       note="deploy 流水线全绿")


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
    pl = proj.add_parser("list")
    pl.add_argument("--include-sensitive", action="store_true",
                    help="显示 customEnv / agentKeys 等敏感字段（默认隐藏）")
    pl.set_defaults(func=cmd_project_list)
    ps = proj.add_parser("show")
    ps.add_argument("id")
    ps.add_argument("--include-sensitive", action="store_true",
                    help="显示 customEnv / agentKeys 等敏感字段（默认隐藏）")
    ps.set_defaults(func=cmd_project_show)
    pt = proj.add_parser("stats"); pt.add_argument("id"); pt.set_defaults(func=cmd_project_stats)
    pc = proj.add_parser("create", help="创建项目骨架(POST /api/projects)")
    pc.add_argument("--name", required=True, help="项目显示名,必填")
    pc.add_argument("--git-url", help="Git 仓库 URL(后续可 clone)")
    pc.add_argument("--slug", help="可选 slug(默认从 name slugify)")
    pc.add_argument("--description", help="可选项目简述")
    pc.set_defaults(func=cmd_project_create)
    pcl = proj.add_parser("clone", help="拉取项目 git(SSE 流式)")
    pcl.add_argument("id", help="projectId")
    pcl.set_defaults(func=cmd_project_clone)
    pd = proj.add_parser("delete", help="级联删除项目(branches/profiles/infra/routing 一起清)")
    pd.add_argument("id", help="projectId")
    pd.set_defaults(func=cmd_project_delete)

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
    bp = br.add_parser("preview-url",
                       help="打印分支 v3 预览域名(来自 /api/branches 的 previewSlug)")
    bp.add_argument("id", help="CDS canonical branch id (非裸 git 分支名)")
    bp.set_defaults(func=cmd_branch_preview_url)
    bc = br.add_parser("create",
                       help="显式创建分支(--project + --branch)。"
                            "API body 字段是 projectId,这里用 --project 抹平。")
    bc.add_argument("--project", help="projectId(或读 CDS_PROJECT_ID)")
    bc.add_argument("--branch", required=True, help="git 分支名(必填)")
    bc.set_defaults(func=cmd_branch_create)

    env = sub.add_parser("env", help="环境变量").add_subparsers(dest="sub", required=True)
    eg = env.add_parser("get"); eg.add_argument("--scope"); eg.set_defaults(func=cmd_env_get)
    es = env.add_parser(
        "set",
        help="设置 env 单键。支持 KEY=VALUE 位置参数,或 --key/--value 组合(value 含 = 时用后者)",
    )
    es.add_argument("kv", nargs="?", help="KEY=VALUE(经典形式,可选)")
    es.add_argument("--key", help="键名(--value 配合)")
    es.add_argument("--value", help="键值(--key 配合,允许空字符串)")
    es.add_argument("--scope")
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

    # ── 新增：init / scan / smoke / help-me-check / deploy ──
    ini = sub.add_parser("init", help="首次接入向导")
    ini.add_argument("--yes", action="store_true", help="非交互模式（CI 用）")
    ini.set_defaults(func=cmd_init)

    pf = sub.add_parser("preflight", help="接入前置检查：CDS_HOST 连通 / 认证 / reposBase 配置")
    pf.set_defaults(func=cmd_preflight)

    onb = sub.add_parser(
        "onboard",
        help="一键 onboard:preflight + create + clone + 提示 required env keys",
    )
    onb.add_argument("git_url", help="Git 仓库 URL(必填)")
    onb.add_argument("--name", help="项目显示名(默认从 URL 推断)")
    onb.add_argument("--slug", help="项目 slug(默认从 URL 推断)")
    onb.add_argument("--description", help="项目简述")
    onb.set_defaults(func=cmd_onboard)

    imp = sub.add_parser("import", help="将已有 compose 文件直接提交到 CDS（不重新扫描）")
    imp.add_argument("--project", required=True, metavar="projectId", help="目标项目 ID")
    imp.add_argument("--compose", required=True, metavar="FILE", help="compose 文件路径（支持自定义文件名）")
    imp.set_defaults(func=cmd_import)

    # ── pending-import 状态查询（issue #553）──────────────────────────
    ist = sub.add_parser("import-status",
                         help="查询单个 pending-import 状态")
    ist.add_argument("id", nargs="?", help="importId")
    ist.set_defaults(func=cmd_import_status)

    iwt = sub.add_parser("import-wait",
                         help="阻塞等待 pending-import 进入终态")
    iwt.add_argument("id", nargs="?", help="importId")
    iwt.add_argument("--timeout", type=int, default=600,
                     help="最长等待秒数（默认 600）")
    iwt.add_argument("--interval", type=int, default=3,
                     help="轮询间隔秒数（默认 3）")
    iwt.set_defaults(func=cmd_import_wait)

    pim = sub.add_parser("project-imports",
                         help="列出某项目的 pending-import 记录")
    pim.add_argument("--project", required=True, metavar="projectId")
    pim.add_argument("--status", default="pending",
                     help="过滤状态：pending(默认)/all/approved/rejected/applied/failed")
    pim.set_defaults(func=cmd_project_imports)

    sc = sub.add_parser("scan", help="扫描本地项目 → compose YAML")
    sc.add_argument("path", nargs="?", default=".")
    sc.add_argument("--apply-to-cds", metavar="projectId",
                    help="扫描后 POST 到 CDS pending-import")
    sc.add_argument("--output", "-o", help="YAML 写入文件（默认 stdout）")
    sc.add_argument("--force-rescan", action="store_true",
                    help="跳过根目录 cds-compose.yml 缓存，强制重新扫描")
    sc.set_defaults(func=cmd_scan)

    vf = sub.add_parser("verify", help="校验 cds-compose 文件(部署前预检 + 评分 + 自愈,SSOT: spec.cds-compose-contract.md)")
    vf.add_argument("path", nargs="?", default=".", help="项目根目录或 compose 文件路径,默认当前目录")
    vf.add_argument("--min-score", type=int, metavar="N",
                    help="评分 < N 时 exit 1(垃圾 compose 质量门禁,0-100)")
    vf.add_argument("--fix", action="store_true",
                    help="输出自愈修补(diff + 建议),默认不落盘")
    vf.add_argument("--write", action="store_true",
                    help="配合 --fix:把可自动修复的改动写回文件(先备份 .bak)")
    vf.set_defaults(func=cmd_verify)

    sm = sub.add_parser("smoke", help="分层冒烟（L1+L2+L3）")
    sm.add_argument("id", help="branchId")
    sm.set_defaults(func=cmd_smoke)

    pu = sub.add_parser(
        "preview-url",
        help="打印当前分支的 v3 预览 URL（零参数，自动从 git + /api/branches 检测，"
             "SSOT: cds/src/services/preview-slug.ts）",
    )
    pu.set_defaults(func=cmd_preview_url)

    bid = sub.add_parser(
        "branch-id",
        help="打印当前 git 分支对应的 CDS canonical id（零参数，多项目 CDS 必备）",
    )
    bid.set_defaults(func=cmd_branch_id)

    hc = sub.add_parser("help-me-check", help="diagnose + 根因分析 + 修复建议")
    hc.add_argument("id", help="branchId")
    hc.set_defaults(func=cmd_help_me_check)

    dp = sub.add_parser("deploy", help="完整流水线（push + pull + deploy + ready + smoke）")
    dp.add_argument("--timeout", type=int, default=300)
    dp.add_argument("--no-smoke", action="store_true")
    dp.set_defaults(func=cmd_deploy)

    # ── 技能自身生命周期 ──
    ver = sub.add_parser("version", help="显示本地 VERSION + 对比服务端最新版")
    ver.set_defaults(func=cmd_version)

    up = sub.add_parser("update", help="从 CDS 下载最新技能包原地替换自己")
    up.set_defaults(func=cmd_update)

    sy = sub.add_parser("sync-from-cds",
                        help="维护者：扫 CDS routes 对比 CLI+docs 找漂移（不改文件）")
    sy.add_argument("--routes-dir", help="CDS routes 目录路径（默认从 git root 推断）")
    sy.add_argument("--quiet", action="store_true", help="静默扫描，不打 stderr 提示")
    sy.set_defaults(func=cmd_sync_from_cds)

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
