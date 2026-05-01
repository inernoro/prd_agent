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

VERSION = "0.2.0"  # ← bumped on each SKILL.md change; 服务端自动读这一行
_TRACE_ID: str = ""
_HUMAN: bool = False
_DRIFT_WARNED: bool = False  # 全进程只提示一次，避免每个请求都刷


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
    cds_compose_path = os.path.join(root, "cds-compose.yml")
    if os.path.exists(cds_compose_path):
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

    # 优先级 3: monorepo 扫描 + 骨架兜底
    modules = _detect_modules(root)
    signals["modules"] = [{"dir": m["dir"], "kind": m["kind"]} for m in modules]
    yaml_content = _yaml_from_modules(root, modules)
    signals["source"] = "monorepo-scan" if modules else "skeleton"
    _emit_scan_result(args, yaml_content, signals,
                      note=f"通过子目录扫描识别 {len(modules)} 个模块" if modules
                           else "未识别已知栈，输出骨架 YAML，请手动补全")
    return


# ── cdscli scan 辅助函数（2026-04-30 Week 4.8 Round 3） ──

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
        ports_block = re.search(r"^\s{4}ports:\s*\n((?:\s{6}-\s+.+\n)+)", content, re.MULTILINE)
        if ports_block:
            svc["ports"] = [
                p.strip().lstrip("- ").strip().strip('"\'')
                for p in ports_block.group(1).strip().split("\n") if p.strip()
            ]
        # Phase 3:解析 volumes 段(给 yaml carry-over 用)。只支持短格式 list:
        #   volumes:
        #     - "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro"
        #     - mysql_data:/var/lib/mysql
        # 长格式 dict({source, target}) 兜底跑不到这里(yaml.safe_load 优先),不补。
        volumes_block = re.search(r"^\s{4}volumes:\s*\n((?:\s{6}-\s+.+\n)+)", content, re.MULTILINE)
        if volumes_block:
            svc["volumes"] = [
                p.strip().lstrip("- ").strip().strip('"\'')
                for p in volumes_block.group(1).strip().split("\n") if p.strip()
            ]
        # Phase 3:解析 environment 段(给 _rewrite_env_value_with_infra_aliases 用)
        # 支持两种 yaml 形式 — dict 和 list
        env_dict_block = re.search(r"^\s{4}environment:\s*\n((?:\s{6}\w[\w_-]*:\s*.+\n)+)", content, re.MULTILINE)
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
            m = re.search(r"server\s*:\s*\{[^}]*?port\s*:\s*(\d+)", text, re.DOTALL)
            if m:
                return m.group(1), f"vite:{cand}"

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


def _detect_modules(root: str) -> list[dict]:
    """子目录扫描:每个有 manifest 的子目录起一个 service。"""
    modules: list[dict] = []
    skip = {"node_modules", "dist", "build", "target", ".git", ".cds-repos",
            ".vscode", ".idea", ".next", ".nuxt", "venv", ".venv"}

    # 先看根目录本身
    if os.path.exists(os.path.join(root, "package.json")):
        modules.append({"dir": ".", "kind": "node",
                        "image": "node:20-slim", "port": "3000"})
    elif any(f.endswith(".csproj") for f in _walk(root, depth=2)):
        modules.append({"dir": ".", "kind": "dotnet",
                        "image": "mcr.microsoft.com/dotnet/sdk:8.0", "port": "5000"})

    # 再扫一层子目录
    if not modules:
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
            if os.path.exists(os.path.join(sub_path, "package.json")):
                modules.append({"dir": sub, "kind": "node",
                                "image": "node:20-slim", "port": "3000"})
            elif any(f.endswith(".csproj") for f in _walk(sub_path, depth=2)):
                modules.append({"dir": sub, "kind": "dotnet",
                                "image": "mcr.microsoft.com/dotnet/sdk:8.0", "port": "5000"})
            elif os.path.exists(os.path.join(sub_path, "go.mod")):
                modules.append({"dir": sub, "kind": "go",
                                "image": "golang:1.22-alpine", "port": "8080"})
            elif os.path.exists(os.path.join(sub_path, "Cargo.toml")):
                modules.append({"dir": sub, "kind": "rust",
                                "image": "rust:1.78", "port": "3000"})
            elif os.path.exists(os.path.join(sub_path, "requirements.txt")) \
                    or os.path.exists(os.path.join(sub_path, "pyproject.toml")):
                modules.append({"dir": sub, "kind": "python",
                                "image": "python:3.12-slim", "port": "8000"})
    return modules


def _yaml_from_modules(root: str, modules: list[dict]) -> str:
    """从 monorepo 模块扫描结果生成 yaml。无模块时输出骨架 + 提示。"""
    project_name = os.path.basename(root)
    lines: list[str] = [
        "# CDS Compose 配置 — 由 cdscli scan 从子目录扫描自动生成",
        "# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴",
        "",
        "x-cds-project:",
        f"  name: {project_name}",
        f"  description: \"{project_name} 全栈项目\"",
        "",
        "x-cds-env:",
        "  # 项目级环境变量(本项目独占,不会跨项目泄漏 / 污染其它项目)",
        "  # CDS_* 前缀 = CDS 自动生成 / 命名空间归 CDS 所有",
        f"  CDS_JWT_SECRET: \"{_gen_password()}\"",
        "",
        "# Phase 8:env 三色 metadata — CDS 弹窗强制用户填 required",
        "x-cds-env-meta:",
        "  CDS_JWT_SECRET:",
        "    kind: auto",
        "    hint: \"CDS 自动生成的 JWT 签名密钥\"",
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

    for i, mod in enumerate(modules):
        name = mod["dir"] if mod["dir"] != "." else project_name
        # 简化 name(去掉 prd- 前缀这种)
        clean_name = name.replace("prd-", "").replace("project-", "")
        kind = mod["kind"]
        lines.append(f"  {clean_name}:")
        lines.append(f"    image: {mod['image']}")
        lines.append(f"    working_dir: /app")
        lines.append(f"    volumes:")
        lines.append(f"      - ./{mod['dir']}:/app")
        lines.append(f"    ports:")
        lines.append(f"      - \"{mod['port']}\"")
        if kind == "node":
            lines.append(f"    command: corepack enable && pnpm install --frozen-lockfile && pnpm exec vite --host 0.0.0.0")
        elif kind == "dotnet":
            lines.append(f"    command: dotnet run --urls http://0.0.0.0:{mod['port']}  # TODO: 改为实际入口")
        elif kind == "go":
            lines.append(f"    command: go run ./...")
        elif kind == "rust":
            lines.append(f"    command: cargo run")
        elif kind == "python":
            lines.append(f"    command: pip install -r requirements.txt && python -m http.server {mod['port']}")
        lines.append(f"    labels:")
        prefix = "/" if i == 0 else f"/{clean_name}/"
        lines.append(f"      cds.path-prefix: \"{prefix}\"")

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
        host = os.environ.get("CDS_HOST", "")
        approve_url = f"https://{host}/project-list?pendingImport={import_id}"
        ok({"importId": import_id, "approveUrl": approve_url, "signals": signals,
            "yamlLen": len(yaml_content)},
           note=f"已提交待批 (importId={import_id}), 去 {approve_url} 批准")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(yaml_content)
        ok({"signals": signals, "writtenTo": args.output},
           note=f"YAML 已写入 {args.output}: {note}")
    ok({"signals": signals, "yaml": yaml_content}, note=note)

    # --apply-to-cds: POST pending-import
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
        host = os.environ.get("CDS_HOST", "")
        approve_url = f"https://{host}/project-list?pendingImport={import_id}"
        ok({"importId": import_id, "approveUrl": approve_url, "signals": signals,
            "yamlLen": len(yaml_content)},
           note=f"已提交待批 (importId={import_id}), 去 {approve_url} 批准")

    # 默认：打印 signals + 输出 YAML 到 stdout
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(yaml_content)
        ok({"signals": signals, "writtenTo": args.output}, note=f"YAML 已写入 {args.output}")
    ok({"signals": signals, "yaml": yaml_content}, note="扫描完成（未提交）")


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


def _verify_load_compose(root: str) -> tuple[str, dict] | None:
    """按 CDS 探测顺序找 compose 文件并解析。返回 (path, doc) 或 None。"""
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
        try:
            import yaml  # type: ignore
        except ImportError:
            die("verify 需要 PyYAML;请 pip install pyyaml(或 python3 -m pip install pyyaml)", code=4)
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
    """有"应用源码"挂载 → app service(与 TS isAppSourceMount 完全对齐)。

    Bugbot fix(PR #521 第十二轮 Bug 1)— 之前任意 ./ 挂载就当 app,但
    `./init.sql:/docker-entrypoint-initdb.d/init.sql:ro` 这种 init script
    挂载属于 infra 初始化,不是 app 源码。误归 mysql 为 app 会让
    `_verify_schemaful_db_migration` 漏掉 schemaful DB 检测,触发假 app
    错误。改用 `_is_app_source_mount` 排除 init / 配置文件挂载。
    """
    vols = svc.get("volumes") or []
    if not isinstance(vols, list):
        return False
    return any(_is_app_source_mount(v) for v in vols if isinstance(v, str))


def _verify_app_workdir(svc_name: str, svc: dict, root: str) -> list[dict]:
    """ERROR:app 的相对 mount workDir 在仓库根不存在。"""
    issues: list[dict] = []
    vols = svc.get("volumes") or []
    if not isinstance(vols, list):
        return issues
    for v in vols:
        if not isinstance(v, str):
            continue
        src = v.split(":")[0]
        if not (src.startswith("./") or src == "."):
            continue
        rel = _strip_dot_slash(src) or "."
        full = os.path.join(root, rel)
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
    """ERROR:env 里的 ${VAR} 在 x-cds-env 里没定义,也无 default。"""
    issues: list[dict] = []
    env = svc.get("environment") or {}
    if not isinstance(env, dict):
        return issues
    for k, v in env.items():
        if not isinstance(v, str):
            continue
        for var in _verify_extract_var_refs(v):
            if var in env_keys:
                continue
            if _verify_has_default(v, var):
                continue
            # 同 service env 自身 key 也算定义(自循环引用容器拿不到,但 Phase 1 fixed-point 会展开 cdsVars)
            if var in env:
                continue
            issues.append({
                "severity": "ERROR",
                "service": svc_name,
                "rule": "env-var-unresolved",
                "message": f"{svc_name}.environment.{k} 引用 ${{{var}}},但 x-cds-env 里没该变量也无默认值",
                "fix": f"在 x-cds-env 加 {var}: <值>,或改成 ${{{var}:-fallback}}",
            })
    return issues


def _verify_schemaful_db_migration(infra_services: dict, app_services: dict) -> list[dict]:
    """WARNING:命中 schemaful DB 时,应用 command 应含 migration 关键词。"""
    has_schemaful = any(
        any(kw in (svc.get("image") or "").lower() for kw in _SCHEMAFUL_DB_NAMES)
        for svc in infra_services.values()
    )
    if not has_schemaful:
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
            "message": f"项目含 schemaful DB(MySQL/Postgres/SQL Server),但应用 {name}.command 不含 migration 关键词",
            "fix": "在 command 前缀加 ORM migration 命令,如 prisma migrate deploy / dotnet ef database update / npm run migration:run",
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
    # INFO
    issues += _verify_password_url_safety(env_decls)
    issues += _verify_dependsOn_hint(app_services, infra_services)
    return issues


def cmd_verify(args: argparse.Namespace) -> None:
    """校验 cds-compose 文件:三级严重度(ERROR / WARNING / INFO)分级输出。

    退出码:
      0 — 无 ERROR(可能含 WARNING/INFO,部署多半能跑)
      1 — 至少一个 ERROR(部署一定挂,先修)
      2 — 解析失败 / yaml 不合法 / 文件找不到
      4 — 缺 PyYAML 等环境问题

    校验规则 SSOT:doc/spec.cds-compose-contract.md § 4。
    """
    root = os.path.abspath(args.path or ".")
    if not os.path.isdir(root):
        die(f"目录不存在: {root}", code=2)

    found = _verify_load_compose(root)
    if not found:
        die(f"未在 {root} 找到 cds-compose.yml / docker-compose.yml(等);先跑 cdscli scan", code=2)
    compose_path, doc = found

    issues = _verify_run_all(doc, root)
    summary = {
        "errors":   sum(1 for i in issues if i["severity"] == "ERROR"),
        "warnings": sum(1 for i in issues if i["severity"] == "WARNING"),
        "infos":    sum(1 for i in issues if i["severity"] == "INFO"),
    }
    payload = {
        "composeFile": os.path.relpath(compose_path, root),
        "issues": issues,
        "summary": summary,
    }
    if summary["errors"] > 0:
        die(f"verify 发现 {summary['errors']} 个 ERROR,{summary['warnings']} 个 WARNING",
            code=1, extra=payload)
    note = f"verify 通过(WARNING={summary['warnings']}, INFO={summary['infos']})"
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
    """分层冒烟：L1 预览域根路径 / L2 version-check / L3 认证 API。"""
    branch_id = args.id
    host = os.environ.get("CDS_HOST", "")
    preview = f"https://{branch_id}.miduo.org" if host.endswith(".miduo.org") or "miduo" in host else f"https://{branch_id}.{host}"
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
    """显示本地 VERSION + 服务端最新 VERSION 的对比。"""
    local = VERSION
    # 尝试读远端
    status, body, _ = _request("GET", "/api/cli-version", timeout=5)
    remote = None
    if status == 200 and isinstance(body, dict):
        remote = body.get("version")
    status_label = "unknown"
    if remote:
        if _version_compare(local, remote) < 0:
            status_label = "stale"
        elif _version_compare(local, remote) == 0:
            status_label = "latest"
        else:
            status_label = "ahead"  # 本地是 dev 版，比线上还新
    payload = {"local": local, "remote": remote, "status": status_label}
    note = f"local={local} remote={remote or '?'} ({status_label})"
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
    branch_id = branch.lower().replace("/", "-")

    # 2. git push
    print(f"[1/4] git push origin {branch}", file=sys.stderr)
    rv = subprocess.run(["git", "push", "-u", "origin", branch],
                        capture_output=True, text=True)
    if rv.returncode != 0:
        die(f"git push 失败: {rv.stderr[:200]}", code=1)

    # 3. CDS pull
    print(f"[2/4] CDS pull branch={branch_id}", file=sys.stderr)
    _call("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/pull", timeout=60)

    # 4. Deploy (reuse cmd_branch_deploy logic)
    print(f"[3/4] CDS deploy (timeout={args.timeout}s)", file=sys.stderr)
    _request("POST", f"/api/branches/{urllib.parse.quote(branch_id)}/deploy", timeout=5)
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

    # ── 新增：init / scan / smoke / help-me-check / deploy ──
    ini = sub.add_parser("init", help="首次接入向导")
    ini.add_argument("--yes", action="store_true", help="非交互模式（CI 用）")
    ini.set_defaults(func=cmd_init)

    sc = sub.add_parser("scan", help="扫描本地项目 → compose YAML")
    sc.add_argument("path", nargs="?", default=".")
    sc.add_argument("--apply-to-cds", metavar="projectId",
                    help="扫描后 POST 到 CDS pending-import")
    sc.add_argument("--output", "-o", help="YAML 写入文件（默认 stdout）")
    sc.set_defaults(func=cmd_scan)

    vf = sub.add_parser("verify", help="校验 cds-compose 文件(部署前预检,SSOT: spec.cds-compose-contract.md)")
    vf.add_argument("path", nargs="?", default=".", help="项目根目录,默认当前目录")
    vf.set_defaults(func=cmd_verify)

    sm = sub.add_parser("smoke", help="分层冒烟（L1+L2+L3）")
    sm.add_argument("id", help="branchId")
    sm.set_defaults(func=cmd_smoke)

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
