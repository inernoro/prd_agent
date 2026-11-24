#!/usr/bin/env python3
"""文学创作 MCP 验收 driver —— 给执行者照跑，不给执行者判断。

为什么要有它：上一轮验收只问「图出来了没有」，而真实问题全在另外几个地方——
用户点名的风格/水印有没有真的用上、同一篇文章被网页和智能体轮流改之后数据还对不对、
旧图有没有被删。这些靠看截图看不出来，必须由机器逐条比对「期望值 vs 实际值」。

用法（只需要四个环境变量）：
  MAP_BASE        预览地址根，例如 https://xxx.miduo.org（用 cdscli preview-url 取，不要自己拼）
  MAP_MCP_KEY     接入台签发的 sk-ak 密钥，勾选「文学创作」
  MAP_USER / MAP_PASSWORD   同一个账号的网页登录口令（网页侧那几条判据要用）
  可选：LIT_STYLE_NAME（默认「验收风格B」）、LIT_WATERMARK_NAME（默认「验收水印1」）

  python3 scripts/acceptance/literary-mcp-driver.py

前置数据（跑之前在网页上建好，driver 第一步会检查，缺了直接 FAIL 并告诉你缺什么）：
  - 文学创作 → 风格/参考图：至少两套，其中一套叫 LIT_STYLE_NAME，且它**不是**当前启用的那套
  - 水印：至少两套，其中一套叫 LIT_WATERMARK_NAME，且它**没有**绑定到文学创作
  这样「指定了」和「用了默认」才分得出来；如果指定的那套恰好就是默认，判据会永远绿。

产出：$LIT_OUT（默认 /tmp/literary-mcp-acceptance）/verdict.json，退出码非 0 即未通过。
执行者只做三件事：设变量、跑脚本、把 verdict.json 原样贴回来。不许改判据，不许把 FAIL 解释成 PASS。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("MAP_BASE", "").rstrip("/")
KEY = os.environ.get("MAP_MCP_KEY", "")
USER = os.environ.get("MAP_USER", "")
PASSWORD = os.environ.get("MAP_PASSWORD", "")
STYLE = os.environ.get("LIT_STYLE_NAME", "验收风格B")
WATERMARK = os.environ.get("LIT_WATERMARK_NAME", "验收水印1")
OUT = os.environ.get("LIT_OUT", "/tmp/literary-mcp-acceptance")
WAIT_SECONDS = int(os.environ.get("LIT_WAIT_SECONDS", "600"))  # 生图 P95 未知时按闭环规则至少 300s
RUN = uuid.uuid4().hex[:8]

checks: list[dict] = []


def check(cid: str, severity: str, title: str, ok: bool, expected, actual) -> bool:
    checks.append({"id": cid, "severity": severity, "title": title, "pass": bool(ok),
                   "expected": expected, "actual": actual})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {title}\n       期望: {expected}\n       实际: {actual}")
    return bool(ok)


def http(method: str, path: str, body=None, token: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"raw": raw[:300].decode(errors="replace")}


def tool(name: str, args: dict) -> tuple[bool, dict]:
    """走真实 MCP 网关（/api/mcp），和外部智能体看到的完全一样。返回 (是否成功, 下游 JSON)。"""
    status, resp = http("POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                            "params": {"name": name, "arguments": args}}, KEY)
    result = resp.get("result") or {}
    text = ((result.get("content") or [{}])[0]).get("text", "")
    try:
        payload = json.loads(text)
    except ValueError:
        payload = {"raw": text or resp}
    return (status == 200 and not result.get("isError")), payload


def data(payload: dict) -> dict:
    return payload.get("data") or {}


def err_code(payload: dict) -> str | None:
    return (payload.get("error") or {}).get("code")


def wait_all_done(ws_id: str, indexes: list[int]) -> dict:
    deadline = time.time() + WAIT_SECONDS
    last = {}
    while time.time() < deadline:
        _, p = tool("map_literary_get_workspace", {"workspaceId": ws_id})
        last = data(p)
        items = {m["index"]: m for m in last.get("illustrations") or []}
        states = [items.get(i, {}).get("status") for i in indexes]
        print(f"       ... 等待生图 {sum(s == 'done' for s in states)}/{len(indexes)} 完成 {states}")
        if all(s in ("done", "error") for s in states):
            return last
        time.sleep(10)
    return last


def main() -> int:
    missing = [n for n, v in [("MAP_BASE", BASE), ("MAP_MCP_KEY", KEY), ("MAP_USER", USER), ("MAP_PASSWORD", PASSWORD)] if not v]
    if missing:
        print(f"缺环境变量：{', '.join(missing)}（见脚本头部说明）")
        return 2
    os.makedirs(OUT, exist_ok=True)

    # ── 0. 前置：风格/水印的测试数据必须能区分「指定」与「默认」 ──
    ok, p = tool("map_literary_list_presets", {})
    presets = data(p)
    check("S0", "P0", "能列出风格/水印预设", ok and "styles" in presets, "返回 styles/watermarks", p if not ok else "ok")
    style = next((s for s in presets.get("styles", []) if s.get("name") == STYLE), None)
    wm = next((w for w in presets.get("watermarks", []) if w.get("name") == WATERMARK), None)
    ready = check("S1", "P0", f"测试风格「{STYLE}」存在且不是默认", bool(style) and not style.get("isDefault"),
                  "存在、isDefault=false", style)
    ready &= check("S2", "P0", f"测试水印「{WATERMARK}」存在且不是默认", bool(wm) and not wm.get("isDefault"),
                   "存在、isDefault=false", wm)
    if not ready:
        return finish("前置数据不齐：按脚本头部说明在网页上建好风格与水印后重跑。")

    # ── 1. 建稿：全角写法、>4 张、无标题、幂等 ──
    article = "# 验收文章 " + RUN + "\n" + "".join(
        f"第{i + 1}段正文。\n{'【插图】' if i % 2 else '[插图]'}：第{i + 1}幅画面，雨后的街角书店\n" for i in range(6))
    cid = f"acc-{RUN}-create"
    ok, p = tool("map_literary_create_workspace", {"markedContent": article, "clientRequestId": cid, "folderName": "验收"})
    d = data(p)
    ws_id = d.get("workspaceId")
    check("C1", "P0", "全角冒号/【插图】写法、6 个标记能建稿", ok and len(d.get("illustrations") or []) == 6,
          "成功，illustrations=6", {"ok": ok, "count": len(d.get("illustrations") or []), "error": p.get("error")})
    check("C2", "P1", "不给标题时取正文第一行", d.get("title", "").startswith("验收文章"), "验收文章…", d.get("title"))
    check("C3", "P1", "建稿回执直接带 workflowVersion", d.get("workflowVersion") == 1, 1, d.get("workflowVersion"))
    if not ws_id:
        return finish("建稿失败，后续无法继续。")
    version = d["workflowVersion"]

    ok, p = tool("map_literary_create_workspace", {"markedContent": article, "clientRequestId": cid, "folderName": "验收"})
    check("C4", "P0", "同一幂等键原样重试 → 同一篇", ok and data(p).get("workspaceId") == ws_id, ws_id, data(p).get("workspaceId"))
    ok, p = tool("map_literary_create_workspace", {"markedContent": "另一篇。\n[插图]: 猫\n", "clientRequestId": cid})
    check("C5", "P0", "同一幂等键换内容 → 冲突，不返回旧文章", (not ok) and err_code(p) == "IDEMPOTENCY_CONFLICT",
          "IDEMPOTENCY_CONFLICT", err_code(p) or data(p))
    ok, p = tool("map_literary_create_workspace", {"markedContent": "正文。\n[插图]：\n下一段不能被吞。\n", "clientRequestId": f"acc-{RUN}-empty"})
    check("C6", "P0", "空描述标记被拒", not ok and "画面描述" in json.dumps(p, ensure_ascii=False), "报错含「画面描述」", p.get("error"))
    ok, p = tool("map_literary_create_workspace", {"content": "正文\n[插图]：书店", "clientRequestId": f"acc-{RUN}-plain"})
    check("C7", "P1", "标记写进普通正文被拦下", not ok, "报错（提示改用 markedContent）", p.get("error"))

    # ── 2. 批量生图：按名称指定风格 + 水印 + 尺寸 ──
    gen = {"workspaceId": ws_id, "markerIndexes": list(range(6)), "workflowVersion": version,
           "clientRequestId": f"acc-{RUN}-gen", "style": STYLE, "watermark": WATERMARK, "size": "16:9"}
    ok, p = tool("map_literary_generate_image", gen)
    d = data(p)
    applied = d.get("applied") or {}
    check("G1", "P0", "一次入队 6 张", ok and len(d.get("runs") or []) == 6, 6, {"ok": ok, "runs": len(d.get("runs") or []), "error": p.get("error")})
    check("G2", "P0", "回执写明用的是指定风格", (applied.get("style") or {}).get("styleId") == style.get("styleId"),
          style.get("styleId"), applied.get("style"))
    check("G3", "P0", "回执写明用的是指定水印", (applied.get("watermark") or {}).get("watermarkId") == wm.get("watermarkId"),
          wm.get("watermarkId"), applied.get("watermark"))
    check("G4", "P1", "尺寸 16:9 被换算", applied.get("size") == "1376x768", "1376x768", applied.get("size"))
    first_runs = sorted(r.get("runId") for r in d.get("runs") or [])

    ok, p = tool("map_literary_generate_image", gen)
    again = sorted(r.get("runId") for r in data(p).get("runs") or [])
    check("G5", "P0", "原样重试不重复入队", ok and again == first_runs and all(r.get("deduplicated") for r in data(p).get("runs") or []),
          "同一批 runId 且 deduplicated", {"same": again == first_runs})
    ok, p = tool("map_literary_generate_image", {**gen, "size": "1:1"})
    check("G6", "P1", "同一幂等键换尺寸 → 冲突", not ok and err_code(p) == "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT", err_code(p))
    ok, p = tool("map_literary_generate_image", {**gen, "clientRequestId": f"acc-{RUN}-bad", "style": "不存在的风格"})
    check("G7", "P1", "风格名写错 → 报错并列出可选项，不偷偷用默认", not ok and STYLE in json.dumps(p, ensure_ascii=False),
          f"报错且列出「{STYLE}」", p.get("error"))

    # ── 3. 闭环：等图真的出来，并且真的打了指定水印 ──
    ws = wait_all_done(ws_id, list(range(6)))
    ill = {m["index"]: m for m in ws.get("illustrations") or []}
    urls = [ill.get(i, {}).get("url") for i in range(6)]
    check("D1", "P0", f"6 张都在 {WAIT_SECONDS}s 内出图（不是超时截图）", all(urls), "6 个 url", urls)
    check("D2", "P0", "图片走的是水印存储路径（指定水印真的打上了）", all(u and "/watermark/" in u for u in urls),
          "每个 url 含 /watermark/", urls)

    ok, p = tool("map_literary_generate_image", {"workspaceId": ws_id, "markerIndex": 0, "workflowVersion": version,
                                                 "clientRequestId": f"acc-{RUN}-nowm", "watermark": "none", "style": "none"})
    ws = wait_all_done(ws_id, [0])
    url0 = ({m["index"]: m for m in ws.get("illustrations") or []}.get(0) or {}).get("url")
    check("D3", "P1", "watermark=none 的那张不打水印", ok and bool(url0) and "/watermark/" not in url0, "url 不含 /watermark/", url0)

    # ── 4. 网页与智能体轮流改同一篇：数据不能乱 ──
    status, login = http("POST", "/api/v1/auth/login", {"username": USER, "password": PASSWORD, "clientType": "admin"})
    jwt = (login.get("data") or {}).get("accessToken")
    if not check("W0", "P0", "网页账号能登录", bool(jwt), "拿到 accessToken", status):
        return finish("网页登录失败，网页侧判据无法执行。")
    status, _ = http("PATCH", f"/api/visual-agent/image-master/workspaces/{ws_id}/article/markers/1",
                     {"draftText": "网页上改了第二幅的描述"}, jwt)
    _, p = tool("map_literary_get_workspace", {"workspaceId": ws_id})
    after = {m["index"]: m for m in data(p).get("illustrations") or []}
    check("W1", "P0", "网页改一个标记后，其它标记的图一张不少", status == 200 and all(after.get(i, {}).get("url") for i in range(6)),
          "6 个 url 仍在", {"patch": status, "urls": [after.get(i, {}).get("url") for i in range(6)]})

    # ── 5. 改稿后重新配图，旧图不删 ──
    token = data(p).get("updatedAt")
    ok, p = tool("map_literary_write_content", {"workspaceId": ws_id, "expectedUpdatedAt": token,
                                                "markedContent": "改过的正文。\n[插图]: 新的第一幅\n第二段。\n[插图]: 新的第二幅\n"})
    d = data(p)
    check("R1", "P0", "带标记改稿 → 配图方案升一版、2 个新标记", ok and d.get("workflowVersion") == version + 1 and len(d.get("illustrations") or []) == 2,
          f"version={version + 1}, 2 个", {"ok": ok, "version": d.get("workflowVersion"), "error": p.get("error")})
    _, p = tool("map_literary_get_workspace", {"workspaceId": ws_id})
    check("R2", "P0", "旧图全部留在历史里（6 张 + 无水印那张）", (data(p).get("historyImageCount") or 0) >= 7, ">= 7", data(p).get("historyImageCount"))
    check("R3", "P0", "新标记上没有挂旧图", all(not m.get("url") for m in data(p).get("illustrations") or []),
          "新标记 url 全空", [m.get("url") for m in data(p).get("illustrations") or []])

    status, h = http("GET", f"/api/literary-agent/workspaces/{ws_id}/illustration-history", token=jwt)
    hd = h.get("data") or {}
    check("R4", "P0", "网页「历史配图」接口列得出全部旧图", status == 200 and (hd.get("total") or 0) >= 7, ">= 7", {"status": status, "total": hd.get("total")})

    status, _ = http("PUT", f"/api/literary-agent/workspaces/{ws_id}", {"articleContent": f"网页上整篇重新上传的正文 {RUN}"}, jwt)
    _, p = tool("map_literary_get_workspace", {"workspaceId": ws_id})
    d = data(p)
    check("R5", "P0", "网页重新上传正文 → 旧标记失效并升版（不再挂着上一版的标记）",
          status == 200 and d.get("workflowVersion") == version + 2 and not d.get("illustrations"),
          f"version={version + 2}, illustrations 为空", {"put": status, "version": d.get("workflowVersion"), "count": len(d.get("illustrations") or [])})
    status, h = http("GET", f"/api/literary-agent/workspaces/{ws_id}/illustration-history", token=jwt)
    check("R6", "P0", "网页改正文后历史配图一张没少", (h.get("data") or {}).get("total", 0) >= 7, ">= 7", (h.get("data") or {}).get("total"))

    print(f"\n人工取证（只截图，不做判断）：登录 {BASE} → 左侧导航「文学创作」→ 打开文件夹「验收」里标题为「验收文章 {RUN}」的那篇"
          f" → 点头部「历史配图」→ 白天、黑夜各截一张。截图里必须看得到至少 7 张图，看不到就记 FAIL。")
    return finish(None, ws_id)


def finish(abort_reason: str | None, ws_id: str | None = None) -> int:
    p0 = [c for c in checks if not c["pass"] and c["severity"] == "P0"]
    p1 = [c for c in checks if not c["pass"] and c["severity"] == "P1"]
    verdict = "fail" if (p0 or abort_reason) else "conditional" if p1 else "pass"
    doc = {"verdict": verdict, "abort": abort_reason, "workspaceId": ws_id, "base": BASE, "run": RUN,
           "failedP0": [c["id"] for c in p0], "failedP1": [c["id"] for c in p1], "checks": checks}
    path = os.path.join(OUT, "verdict.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    print(f"\nverdict={verdict}  P0 失败={len(p0)}  P1 失败={len(p1)}  → {path}")
    return 0 if verdict == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
