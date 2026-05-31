#!/usr/bin/env python3
"""日报发布到知识库（文档空间）。

find-or-create「日报知识库」→ 建条目 → 写正文（带 hasContent 校验 + 空壳兜底）→ 出分享链。
鉴权：优先 DAILY_DOC_STORE_KEY=sk-ak-*（Bearer，最小权限 document-store:write），
回退 AI_ACCESS_KEY 超级密钥 + X-AI-Impersonate。

用法：
  export AI_ACCESS_KEY=...
  python3 publish.py --base https://main-prd-agent.miduo.org \
    --impersonate inernoro --title "日报-2026-05-31-今日大事早知道" \
    --report-md /tmp/daily.md
"""
import argparse, json, os, subprocess, time, sys

API = "/api/document-store"
STORE_NAME = "日报知识库"
STORE_DESC = "每日开发日报归档（今日大事早知道）。新增方向多讲，优化/修复次之，计划/遗留垫底。"


def curl(args, retries=5):
    last = ""
    for i in range(retries):
        r = subprocess.run(["curl", "-s", "--max-time", "150"] + args, capture_output=True, text=True)
        last = r.stdout
        try:
            return json.loads(r.stdout)
        except Exception:
            if i < retries - 1:
                time.sleep(3 * (i + 1)); continue
    print("RAW(重试后仍失败):", (last or "")[:200]); raise RuntimeError("curl 返回非 JSON（多为预览环境 524/重启）")


def headers(impersonate, with_json=False):
    key = os.environ.get("DAILY_DOC_STORE_KEY", "").strip()
    if key:
        h = ["-H", f"Authorization: Bearer {key}"]
        print("  鉴权：DAILY_DOC_STORE_KEY scoped key（最小权限）")
    else:
        h = ["-H", f"X-AI-Access-Key: {os.environ['AI_ACCESS_KEY']}",
             "-H", f"X-AI-Impersonate: {impersonate}"]
        print(f"  鉴权：AI 超级密钥 + impersonate={impersonate}")
    if with_json:
        h += ["-H", "Content-Type: application/json"]
    return h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="环境 base URL，如 https://main-prd-agent.miduo.org")
    ap.add_argument("--impersonate", default="inernoro")
    ap.add_argument("--title", required=True)
    ap.add_argument("--report-md", required=True, help="正文 md（以 # 标题打头）")
    ap.add_argument("--daily-date", default="", help="metadata.dailyDate，便于去重/检索")
    a = ap.parse_args()

    base = a.base.rstrip("/") + API
    H = headers(a.impersonate)
    HJ = headers(a.impersonate, with_json=True)
    body = open(a.report_md, encoding="utf-8").read().lstrip()
    if not body.startswith("#"):
        body = f"# {a.title}\n\n" + body

    # find-or-create store
    stores = curl(H + [f"{base}/stores?pageSize=100"])["data"]["items"]
    match = [s for s in stores if s["name"] == STORE_NAME]
    if match:
        rid = match[0]["id"]
        print(f"  复用知识库「{STORE_NAME}」id={rid}")
    else:
        rid = curl(HJ + ["-X", "POST", "-d", json.dumps(
            {"name": STORE_NAME, "description": STORE_DESC, "isPublic": False}
        ), f"{base}/stores"])["data"]["id"]
        print(f"  新建知识库「{STORE_NAME}」id={rid}")

    # create entry
    meta = {"kind": "daily-report", "dailyDate": a.daily_date or a.title}
    eid = curl(HJ + ["-X", "POST", "-d", json.dumps({
        "title": a.title, "summary": f"# {a.title}",
        "sourceType": "reference", "contentType": "text/markdown",
        "tags": ["日报", "今日大事"], "metadata": meta,
    }), f"{base}/stores/{rid}/entries"])["data"]["id"]
    print(f"  条目 id={eid} title={a.title}")

    # write content + verify hasContent (空壳兜底)
    def has_content():
        try:
            return bool(curl(H + [f"{base}/entries/{eid}/content"], retries=2).get("data", {}).get("hasContent"))
        except Exception:
            return False
    ok = False
    try:
        w = curl(HJ + ["-X", "PUT", "-d", json.dumps({"content": body}), f"{base}/entries/{eid}/content"])
        print(f"  写正文 success={w.get('success')}")
        ok = has_content()
        if not ok:
            curl(HJ + ["-X", "PUT", "-d", json.dumps({"content": body}), f"{base}/entries/{eid}/content"])
            ok = has_content()
    except Exception as e:
        print(f"  写正文异常：{str(e)[:120]}")
        ok = has_content()
    if not ok:
        try:
            curl(H + ["-X", "DELETE", f"{base}/entries/{eid}"], retries=2)
            print(f"  正文未生效，已删空壳条目 {eid}")
        except Exception:
            print(f"  正文未生效且删除失败；稳定后请手动删条目 {eid}")
        raise RuntimeError("正文写入未生效(hasContent=false)，请稍后重跑")
    print("  正文已校验落库 hasContent=true")

    # share link
    share_url = None
    try:
        tok = curl(HJ + ["-X", "POST", "-d", json.dumps({"title": a.title, "expiresInDays": 0}),
                         f"{base}/stores/{rid}/share-links"])["data"]["token"]
        share_url = f"{a.base.rstrip('/')}/s/lib/{tok}?entry={eid}"
    except Exception as e:
        print("  分享链生成失败（可登录后手动分享）：", str(e)[:120])

    print(json.dumps({"storeId": rid, "entryId": eid, "title": a.title, "shareUrl": share_url,
                      "ownerView": f"登录后 知识库 → 「{STORE_NAME}」→ 本篇"}, ensure_ascii=False))
    print("\n===== 日报发布完成 =====")
    print("分享链：" + (share_url or "（分享接口超时，请登录后在该库手动生成）"))
    print(f"Owner 自看：登录后 知识库 → 「{STORE_NAME}」→ 本篇")


if __name__ == "__main__":
    main()
