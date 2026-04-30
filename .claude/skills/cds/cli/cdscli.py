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
                yaml_content = _yaml_from_compose_services(root, services)
                signals["source"] = f"docker-compose ({chosen})"
                signals["servicesCount"] = len(services)
                _emit_scan_result(args, yaml_content, signals,
                                  note=f"从 {chosen} 解析出 {len(services)} 个服务")
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
        services[name] = svc
    return services


# 基础设施 image 关键词 → 是否为 infra
# ── 基础设施模板穷举(2026-05-01,Railway-style)──────────────────
# 每个模板:image / 容器 port / 容器初始化所需 env / 应用侧连接串。
# 命中规则:image name 包含任一 match_keywords 即认为是该 infra。
# password_keys 自动用 secrets.token_urlsafe(16) 生成,用户可改;
# 用 ${VAR} 引用让 service 段和 x-cds-env 段两边共享同一字符串。
_INFRA_TEMPLATES: list[dict] = [
    {
        "name": "mongodb",
        "match": ["mongo"],
        "image": "mongo:8.0",
        "container_port": "27017",
        "service_env": {
            "MONGO_INITDB_ROOT_USERNAME": "${MONGO_USER}",
            "MONGO_INITDB_ROOT_PASSWORD": "${MONGO_PASSWORD}",
        },
        "global_env": [
            ("MONGO_USER", "root", False, "MongoDB root 用户名"),
            ("MONGO_PASSWORD", None, True, "MongoDB root 密码(自动随机)"),
            ("MONGODB_URL", "mongodb://${MONGO_USER}:${MONGO_PASSWORD}@mongodb:27017/admin?authSource=admin", False, "应用侧连接串"),
        ],
    },
    {
        "name": "redis",
        "match": ["redis"],
        "image": "redis:7-alpine",
        "container_port": "6379",
        "service_env": {},
        "service_command": "redis-server --requirepass ${REDIS_PASSWORD}",
        "global_env": [
            ("REDIS_PASSWORD", None, True, "Redis 密码(自动随机)"),
            ("REDIS_URL", "redis://:${REDIS_PASSWORD}@redis:6379/0", False, "应用侧连接串"),
        ],
    },
    {
        "name": "postgres",
        "match": ["postgres", "timescale"],
        "image": "postgres:16-alpine",
        "container_port": "5432",
        "service_env": {
            "POSTGRES_USER": "${POSTGRES_USER}",
            "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}",
            "POSTGRES_DB": "${POSTGRES_DB}",
        },
        "global_env": [
            ("POSTGRES_USER", "postgres", False, "Postgres 用户名"),
            ("POSTGRES_PASSWORD", None, True, "Postgres 密码(自动随机)"),
            ("POSTGRES_DB", "app", False, "默认数据库"),
            ("DATABASE_URL", "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}", False, "应用侧连接串"),
        ],
    },
    {
        "name": "mysql",
        "match": ["mysql", "mariadb"],
        "image": "mysql:8",
        "container_port": "3306",
        "service_env": {
            "MYSQL_ROOT_PASSWORD": "${MYSQL_ROOT_PASSWORD}",
            "MYSQL_DATABASE": "${MYSQL_DATABASE}",
            "MYSQL_USER": "${MYSQL_USER}",
            "MYSQL_PASSWORD": "${MYSQL_PASSWORD}",
        },
        "global_env": [
            ("MYSQL_ROOT_PASSWORD", None, True, "MySQL root 密码(自动随机)"),
            ("MYSQL_DATABASE", "app", False, "默认数据库"),
            ("MYSQL_USER", "app", False, "应用专用用户"),
            ("MYSQL_PASSWORD", None, True, "应用密码(自动随机)"),
            ("DATABASE_URL", "mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@mysql:3306/${MYSQL_DATABASE}", False, "应用侧连接串"),
        ],
    },
    {
        "name": "sqlserver",
        "match": ["mssql", "sql-server", "mcr.microsoft.com/mssql"],
        "image": "mcr.microsoft.com/mssql/server:2022-latest",
        "container_port": "1433",
        "service_env": {
            "ACCEPT_EULA": "Y",
            "MSSQL_SA_PASSWORD": "${SQLSERVER_SA_PASSWORD}",
            "MSSQL_PID": "Developer",
        },
        "global_env": [
            ("SQLSERVER_SA_PASSWORD", None, True, "SQL Server SA 密码(自动随机,必须含大写+数字+特殊符号,长度≥8)"),
            ("SQLSERVER_URL", "Server=sqlserver,1433;Database=master;User Id=sa;Password=${SQLSERVER_SA_PASSWORD};TrustServerCertificate=True;", False, "ADO.NET 连接串"),
        ],
    },
    {
        "name": "clickhouse",
        "match": ["clickhouse"],
        "image": "clickhouse/clickhouse-server:24-alpine",
        "container_port": "8123",
        "service_env": {
            "CLICKHOUSE_USER": "${CLICKHOUSE_USER}",
            "CLICKHOUSE_PASSWORD": "${CLICKHOUSE_PASSWORD}",
            "CLICKHOUSE_DB": "${CLICKHOUSE_DB}",
            "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT": "1",
        },
        "global_env": [
            ("CLICKHOUSE_USER", "default", False, "ClickHouse 用户名"),
            ("CLICKHOUSE_PASSWORD", None, True, "ClickHouse 密码(自动随机)"),
            ("CLICKHOUSE_DB", "default", False, "默认数据库"),
            ("CLICKHOUSE_URL", "http://${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}@clickhouse:8123/${CLICKHOUSE_DB}", False, "应用侧 HTTP 连接串"),
        ],
    },
    {
        "name": "rabbitmq",
        "match": ["rabbitmq"],
        "image": "rabbitmq:3-management-alpine",
        "container_port": "5672",
        "service_env": {
            "RABBITMQ_DEFAULT_USER": "${RABBITMQ_USER}",
            "RABBITMQ_DEFAULT_PASS": "${RABBITMQ_PASSWORD}",
        },
        "global_env": [
            ("RABBITMQ_USER", "guest", False, "RabbitMQ 用户名"),
            ("RABBITMQ_PASSWORD", None, True, "RabbitMQ 密码(自动随机)"),
            ("AMQP_URL", "amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@rabbitmq:5672/", False, "AMQP 连接串"),
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
            "ELASTIC_PASSWORD": "${ELASTIC_PASSWORD}",
            "ES_JAVA_OPTS": "-Xms512m -Xmx512m",
        },
        "global_env": [
            ("ELASTIC_PASSWORD", None, True, "Elasticsearch elastic 用户密码(自动随机)"),
            ("ELASTICSEARCH_URL", "http://elastic:${ELASTIC_PASSWORD}@elasticsearch:9200", False, "应用侧连接串"),
        ],
    },
    {
        "name": "minio",
        "match": ["minio"],
        "image": "minio/minio:latest",
        "container_port": "9000",
        "service_env": {
            "MINIO_ROOT_USER": "${MINIO_ROOT_USER}",
            "MINIO_ROOT_PASSWORD": "${MINIO_ROOT_PASSWORD}",
        },
        "service_command": "server /data --console-address :9001",
        "global_env": [
            ("MINIO_ROOT_USER", "minioadmin", False, "MinIO 管理用户(同时是 S3 access key)"),
            ("MINIO_ROOT_PASSWORD", None, True, "MinIO 密码(自动随机,同时是 S3 secret key)"),
            ("S3_ENDPOINT", "http://minio:9000", False, "S3 API endpoint"),
            ("S3_ACCESS_KEY", "${MINIO_ROOT_USER}", False, "S3 access key"),
            ("S3_SECRET_KEY", "${MINIO_ROOT_PASSWORD}", False, "S3 secret key"),
        ],
    },
    {
        "name": "nats",
        "match": ["nats"],
        "image": "nats:2-alpine",
        "container_port": "4222",
        "service_env": {},
        "global_env": [
            ("NATS_URL", "nats://nats:4222", False, "NATS 连接串(无密码)"),
        ],
    },
    {
        "name": "memcached",
        "match": ["memcached"],
        "image": "memcached:1-alpine",
        "container_port": "11211",
        "service_env": {},
        "global_env": [
            ("MEMCACHED_URL", "memcached:11211", False, "Memcached 连接串"),
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
    """生成强随机密码:URL-safe + 长度 16,适合 SQL Server 等严格策略。
    SQL Server 要求大写+数字+特殊符号 ≥8,这里生成的 token_urlsafe 含 A-Z + 数字 + - / _,
    再额外缀一个 '!' 兜底"特殊字符"要求。"""
    import secrets
    return secrets.token_urlsafe(16) + "!"


def _yaml_from_compose_services(root: str, services: dict) -> str:
    """把 docker-compose services 转成 cds-compose 格式。

    基础设施识别(2026-05-01 增强):
      - 命中 _INFRA_TEMPLATES 的 image → 用模板渲染完整 service 段(image
        统一替换为推荐 stable image,自动加初始化 env 引用 ${VAR})
      - 同时把账号密码 + 应用侧连接串写入 x-cds-env(随机生成密码,加注释)
      - 应用侧通过 ${MONGODB_URL} / ${DATABASE_URL} 等读取连接串,与容器
        side 共享同一字符串 — Railway 心智:同名变量两边自动通

    无模板的 image 走原"裸抄"路径,只把 image+ports 抄过来,加 TODO 注释。
    """
    project_name = os.path.basename(root)
    # 先扫一遍服务,收集需要的 infra 模板 + 渲染信号
    infra_renders: list[dict] = []  # 命中模板的 infra:{name, template, original_image}
    raw_infras: list[str] = []  # 是 infra 但没匹配到模板,走兜底
    app_names: list[str] = []

    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        image = svc.get("image", "")
        tpl = _find_infra_template(image)
        if tpl is not None:
            infra_renders.append({"name": tpl["name"], "template": tpl, "original_image": image})
        elif _is_infra_image(image):  # 历史 _is_infra_image 现在与 _find_infra_template 等价,保留保险
            raw_infras.append(name)
        else:
            app_names.append(name)

    # 收集 x-cds-env 顶层键(去重,后到的覆盖)
    global_env_decls: dict[str, tuple] = {}  # key → (value, is_password, comment)
    for r in infra_renders:
        for entry in r["template"]["global_env"]:
            key, default, is_password, comment = entry
            value = _gen_password() if is_password and default is None else default
            global_env_decls[key] = (value, is_password, comment)

    # 通用 env(用户应用层会用到)
    common_env = [
        ("JWT_SECRET", _gen_password(), True, "JWT 签名密钥(自动随机,改了所有 token 失效)"),
        ("AI_ACCESS_KEY", "TODO: 请填写实际值", False, "AI 服务访问 key"),
    ]
    for key, value, is_pwd, comment in common_env:
        global_env_decls.setdefault(key, (value, is_pwd, comment))

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

    lines.append("")
    lines.append("services:")

    # ── 渲染基础设施(用模板)──
    for r in infra_renders:
        name = r["name"]
        tpl = r["template"]
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

    # ── 渲染应用 service ──
    for name in app_names:
        svc = services[name]
        port = _first_port(svc.get("ports") or [])
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
            lines.append(f"      - \"{port}\"")
        # 第一个 app 服务挂 / 路径,其它给 TODO
        if name == app_names[0]:
            lines.append(f"    labels:")
            lines.append(f"      cds.path-prefix: \"/\"")
        else:
            lines.append(f"    labels:")
            lines.append(f"      # TODO: 调整为实际路径前缀")
            lines.append(f"      cds.path-prefix: \"/{name}/\"")

    return "\n".join(lines) + "\n"


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
        "  JWT_SECRET: \"TODO: 请填写实际值\"",
        "  AI_ACCESS_KEY: \"TODO: 请填写实际值\"",
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
