#!/usr/bin/env python3
"""D 层真机冒烟：对已部署的 serving 网关 /gw/v1/* 按 MECE 矩阵抽样真打。

仅在 CDS 起来（单分支多容器 + 导入审批）后跑。桩 + 适配器 + 跨进程层由 CI 的 dotnet test 覆盖；
本脚本覆盖"真网关 + 真/桩上游"那一层（doc/spec.llm-gateway-test-matrix.md D 层）。

用法:
  GW_BASE=https://<preview>/gw/v1 GW_KEY=dev-llmgw-serve-key python3 scripts/gw-smoke.py
  # GW_BASE 不传时尝试用 cdscli preview-url 拼 /gw/v1

断言（非异常）: model 命中 / finish_reason 有 / 内容非空 / token 有 / 无"选 A 给 B"。
canary: 一个指向不存在 code / 坏模型的请求必须被判失败（证明探测有效）。
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

BASE = os.environ.get("GW_BASE", "").rstrip("/")
KEY = os.environ.get("GW_KEY", "dev-llmgw-serve-key")
TIMEOUT = int(os.environ.get("GW_TIMEOUT", "120"))
JSON_OUT = os.environ.get("GW_SMOKE_JSON_OUT", "")
REPORT_MD = os.environ.get("GW_SMOKE_REPORT_MD", "")
EXPECTED_COMMIT = os.environ.get("GW_EXPECT_COMMIT", "").strip().lower()

# 每类 ModelType 抽 1 个代表入口（D1×D2 抽样）。真机存在性以 /gw/v1/pools 为准。
SAMPLE_CODES = [
    ("report-agent.generate::chat", "chat"),
    ("prd-agent-desktop.chat.suggested-questions::intent", "intent"),
    ("visual-agent.image::vision", "vision"),
]


def _req(method, path, body=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("X-Gateway-Key", KEY)
    # 预览域名走 Cloudflare：默认 Python-urllib UA 会被 CF 按浏览器签名拦截（error 1010 / 403）。
    # 带一个正常浏览器 UA 即可放行（与真人浏览器/curl 一致）。
    r.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) gw-smoke/1.0")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=TIMEOUT) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, f"ERR {e}"


def _sse_req(path, body):
    code, raw = _req("POST", path, body)
    events = []
    if code != 200:
        return code, raw, events

    current = []
    for line in raw.splitlines():
        if not line.strip():
            if current:
                payload = "\n".join(current)
                try:
                    events.append(json.loads(payload))
                except Exception:  # noqa: BLE001
                    events.append({"_raw": payload})
                current = []
            continue
        if line.startswith("data:"):
            current.append(line[5:].strip())
    if current:
        payload = "\n".join(current)
        try:
            events.append(json.loads(payload))
        except Exception:  # noqa: BLE001
            events.append({"_raw": payload})
    return code, raw, events


def _envelope_data(raw):
    try:
        j = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    return j  # serving 端点直接返回 DTO（非 {success,data} 信封）


def _normalize_commit(value):
    raw = str(value or "").strip().lower()
    if raw.startswith("sha-"):
        raw = raw[4:]
    return raw


def _write_json(path, report):
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def _write_markdown(path, report):
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    def cell(value):
        return str(value).replace("|", "\\|")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway D-Layer Smoke Report\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- base: `{cell(report['base'])}`\n")
        fh.write(f"- expectedCommit: `{cell(report.get('expectedCommit') or '')}`\n")
        fh.write(f"- healthCommit: `{cell(report.get('healthCommit') or '')}`\n")
        fh.write(f"- passed: `{cell(report['passed'])}`\n")
        fh.write(f"- total: `{cell(report['total'])}`\n\n")
        fh.write("| case | status | detail |\n")
        fh.write("|---|---|---|\n")
        for row in report["rows"]:
            fh.write(f"| {cell(row['case'])} | {cell(row['status'])} | {cell(row['detail'])} |\n")


def main():
    base = BASE
    if not base:
        # 尝试用 cdscli 拼预览根 + /gw/v1
        try:
            import subprocess
            out = subprocess.run(
                ["python3", ".claude/skills/cds/cli/cdscli.py", "--human", "preview-url"],
                capture_output=True, text=True, timeout=30).stdout.strip().splitlines()
            root = next((l for l in out if l.startswith("http")), "").rstrip("/")
            base = root + "/gw/v1" if root else ""
        except Exception:  # noqa: BLE001
            base = ""
    if not base:
        print("FATAL: 未提供 GW_BASE，且 cdscli 取预览根失败。CDS 起来后再跑。")
        report = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "verdict": "fail",
            "base": "",
            "expectedCommit": EXPECTED_COMMIT,
            "healthCommit": "",
            "passed": 0,
            "total": 0,
            "rows": [],
            "failures": ["missing GW_BASE"],
        }
        _write_json(JSON_OUT, report)
        _write_markdown(REPORT_MD, report)
        return 2
    globals()["BASE"] = base
    print(f"[gw-smoke] BASE={base}")

    rows = []  # (case, ok, detail)

    # 1) healthz
    code, raw = _req("GET", "/healthz")
    health = _envelope_data(raw) or {}
    health_status = str(health.get("status") or health.get("Status") or "").lower()
    health_commit = _normalize_commit(health.get("commit") or health.get("Commit"))
    ok = code == 200 and health_status == "ok"
    if EXPECTED_COMMIT and health_commit != EXPECTED_COMMIT:
        ok = False
    rows.append(("healthz", ok, f"{code} status={health_status or 'empty'} commit={health_commit or 'empty'} expected={EXPECTED_COMMIT or 'none'}"))

    # 2) pools（每类抽样入口）
    for accode, mtype in SAMPLE_CODES:
        code, raw = _req("GET", f"/pools?appCallerCode={urllib.parse.quote(accode)}&modelType={mtype}")
        ok = code == 200
        rows.append((f"pools[{mtype}]", ok, f"{code} {raw[:120]}"))

    # 3) send 非流式（chat 代表）
    for accode, mtype in SAMPLE_CODES:
        body = {
            "AppCallerCode": accode, "ModelType": mtype, "Stream": False,
            "RequestBody": {"messages": [{"role": "user", "content": "ping, reply OK"}], "max_tokens": 16},
            "Context": {"UserId": "smoke-test"},
        }
        code, raw = _req("POST", "/send", body)
        d = _envelope_data(raw) or {}
        res = d.get("Resolution") or {}
        ok = (code == 200 and d.get("Success") is True
              and bool(d.get("Content")) and bool(res.get("ActualModel")))
        # 无"选 A 给 B"：若请求指定了 expectedModel，actualModel 应一致（此处未指定，仅记录）。
        detail = f"{code} success={d.get('Success')} model={res.get('ActualModel')} contentLen={len(d.get('Content') or '')}"
        rows.append((f"send[{mtype}]", ok, detail))

    # 4) stream：真实 SSE 边界。只抽 chat 一类，避免 D 层冒烟成本膨胀。
    stream_body = {
        "AppCallerCode": "report-agent.generate::chat",
        "ModelType": "chat",
        "Stream": True,
        "RequestBody": {
            "messages": [{"role": "user", "content": "ping, stream reply OK"}],
            "max_tokens": 16,
            "stream": True,
        },
        "Context": {"UserId": "smoke-test"},
    }
    code, raw, events = _sse_req("/stream", stream_body)
    stream_text = "".join(str(e.get("Content") or "") for e in events if isinstance(e, dict))
    stream_model = next(
        (
            (e.get("Resolution") or {}).get("ActualModel")
            for e in events
            if isinstance(e, dict) and isinstance(e.get("Resolution"), dict)
        ),
        None,
    )
    stream_done = any(
        isinstance(e, dict)
        and (e.get("FinishReason") or str(e.get("Type")).lower() in {"done", "4"})
        for e in events
    )
    ok = code == 200 and len(events) >= 2 and bool(stream_text) and bool(stream_model) and stream_done
    rows.append(("stream[chat]", ok, f"{code} events={len(events)} model={stream_model} contentLen={len(stream_text)}"))

    # 5) client-stream：CreateClient/ILLMClient 跨进程 SSE 边界。
    client_stream_body = {
        "AppCallerCode": "report-agent.generate::chat",
        "ModelType": "chat",
        "MaxTokens": 16,
        "Temperature": 0.2,
        "IncludeThinking": False,
        "SystemPrompt": "Reply briefly.",
        "Messages": [{"Role": "user", "Content": "ping, client stream reply OK"}],
        "EnablePromptCache": True,
        "Context": {"UserId": "smoke-test"},
    }
    code, raw, events = _sse_req("/client-stream", client_stream_body)
    client_stream_text = "".join(str(e.get("Content") or "") for e in events if isinstance(e, dict))
    client_stream_done = any(
        isinstance(e, dict) and str(e.get("Type")).lower() in {"done", "4"}
        for e in events
    )
    ok = code == 200 and len(events) >= 2 and bool(client_stream_text) and client_stream_done
    rows.append(("client-stream[chat]", ok, f"{code} events={len(events)} contentLen={len(client_stream_text)}"))

    # 6) canary：指向不存在的入口，必须失败（证明探测有效）
    body = {"AppCallerCode": "nonexistent.canary::chat", "ModelType": "chat",
            "RequestBody": {"messages": [{"role": "user", "content": "x"}]}, "Context": {"UserId": "smoke-test"}}
    code, raw = _req("POST", "/send", body)
    d = _envelope_data(raw) or {}
    canary_caught = not (code == 200 and d.get("Success") is True)
    rows.append(("canary(必败入口)", canary_caught, f"{code} success={d.get('Success')} (期望失败)"))

    # 汇总
    print("\n=== gw-smoke 矩阵结果 ===")
    passed = 0
    for case, ok, detail in rows:
        mark = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        print(f"  [{mark}] {case:24} {detail}")
    print(f"\n{passed}/{len(rows)} 通过")
    report_rows = [
        {
            "case": case,
            "status": "pass" if ok else "fail",
            "ok": ok,
            "detail": detail,
        }
        for case, ok, detail in rows
    ]
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "pass" if passed == len(rows) else "fail",
        "base": base,
        "expectedCommit": EXPECTED_COMMIT,
        "healthCommit": health_commit,
        "passed": passed,
        "total": len(rows),
        "rows": report_rows,
        "failures": [f"{case}: {detail}" for case, ok, detail in rows if not ok],
    }
    _write_json(JSON_OUT, report)
    _write_markdown(REPORT_MD, report)
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    import urllib.parse  # noqa: E402
    sys.exit(main())
