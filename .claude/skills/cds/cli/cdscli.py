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
            f"运行 `cdscli update` 升级（或 📦 Dashboard 重新下载）。"
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
    print(f"  ✓ CDS_HOST={host}\n", file=sys.stderr)

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
            print(f"  ✓ 已读到环境里的 AI_ACCESS_KEY (长度 {len(existing)})", file=sys.stderr)
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
    print("  ✓ 认证通过\n", file=sys.stderr)

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
    print(f"  ✓ 已写入 {cdsrc}", file=sys.stderr)
    print(f'\n下一步: source {cdsrc} 然后 cdscli auth check', file=sys.stderr)
    ok({"host": host, "authMethod": choice, "projectId": pid or None,
        "cdsrcPath": cdsrc}, note="init 完成")


def cmd_scan(args: argparse.Namespace) -> None:
    """扫描本地项目结构，输出 cds-compose YAML。--apply-to-cds 直接 POST 到 CDS。"""
    root = os.path.abspath(args.path or ".")
    if not os.path.isdir(root):
        die(f"目录不存在: {root}", code=1)

    # 轻量扫描：只列可信号，不猜具体 command
    signals: dict[str, Any] = {"root": root}

    def has(p: str) -> bool:
        return os.path.exists(os.path.join(root, p))

    # 检测基础设施（从 docker-compose.*.yml）
    compose_candidates = [f for f in os.listdir(root)
                          if f.startswith("docker-compose") and f.endswith((".yml", ".yaml"))]
    signals["composeFiles"] = compose_candidates

    # 检测后端语言
    backends: list[dict[str, str]] = []
    if any(f.endswith(".csproj") for f in _walk(root, depth=3)):
        backends.append({"kind": "dotnet", "image": "mcr.microsoft.com/dotnet/sdk:8.0",
                         "port": "5000"})
    for sub in ("prd-api", "api", "backend", "server"):
        if has(sub) and os.path.isdir(os.path.join(root, sub)):
            backends.append({"kind": "subdir", "dir": sub})

    # 检测前端
    frontends: list[dict[str, str]] = []
    for sub in ("prd-admin", "admin", "web", "frontend", "client"):
        pkg = os.path.join(root, sub, "package.json")
        if os.path.exists(pkg):
            frontends.append({"kind": "node", "dir": sub, "port": "8000"})
    if not frontends and os.path.exists(os.path.join(root, "package.json")):
        frontends.append({"kind": "node", "dir": ".", "port": "3000"})

    signals["backends"] = backends
    signals["frontends"] = frontends

    # 读一个 docker-compose 的 services 作 infra 候选
    infra_services: list[str] = []
    if compose_candidates:
        try:
            with open(os.path.join(root, compose_candidates[0]), "r", encoding="utf-8") as f:
                txt = f.read()
            import re
            for m in re.finditer(r"^\s{0,4}([a-z][\w-]{1,20}):\s*\n", txt, re.MULTILINE):
                name = m.group(1)
                if name in ("services", "volumes", "networks", "version"):
                    continue
                infra_services.append(name)
        except Exception:
            pass
    signals["infraCandidates"] = infra_services[:8]

    # 输出 compose YAML（骨架，用户需后续调整）
    yaml_parts: list[str] = [
        "# CDS Compose 配置 — 由 cdscli scan 自动生成",
        "# 导入方式：CDS Dashboard → 设置 → 一键导入 → 粘贴",
        "",
        "x-cds-project:",
        f"  name: {os.path.basename(root)}",
        f"  description: \"{os.path.basename(root)} 全栈项目\"",
        "",
        "x-cds-env:",
        "  # 全局共享环境变量 — CDS 自动注入所有容器",
        "  JWT_SECRET: \"TODO: 请填写\"",
        "  AI_ACCESS_KEY: \"TODO: 请填写\"",
        "",
        "services:",
    ]
    for be in backends[:1]:
        if be.get("kind") == "dotnet":
            yaml_parts += [
                "  api:",
                "    image: mcr.microsoft.com/dotnet/sdk:8.0",
                "    working_dir: /app",
                "    volumes:",
                "      - ./:/app",
                "    ports:",
                "      - \"5000\"",
                "    command: dotnet run --project src --urls http://0.0.0.0:5000",
                "    labels:",
                "      cds.path-prefix: \"/api/\"",
            ]
    for fe in frontends[:1]:
        subdir = fe.get("dir", ".")
        yaml_parts += [
            "  web:",
            "    image: node:20-slim",
            "    working_dir: /app",
            "    volumes:",
            f"      - ./{subdir}:/app",
            f"    ports:",
            f"      - \"{fe.get('port', '3000')}\"",
            "    command: corepack enable && pnpm install --frozen-lockfile && pnpm exec vite --host 0.0.0.0",
            "    labels:",
            "      cds.path-prefix: \"/\"",
        ]
    yaml_content = "\n".join(yaml_parts) + "\n"

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
            f"请用 Dashboard 的 📦 按钮重新下载完整包。", code=1)

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
