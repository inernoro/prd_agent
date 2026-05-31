#!/usr/bin/env python3
"""日报发布到知识库（文档空间），或 --local 落本地 md。

find-or-create「日报知识库」→（有截图则先上传图、回填 {{IMG:}}/{{EVIDENCE}} 占位）→
建条目 → 写正文（带 hasContent 校验 + 空壳兜底）→ 出分享链。
鉴权：优先 DAILY_DOC_STORE_KEY=sk-ak-*（Bearer，最小权限 document-store:write），
回退 AI_ACCESS_KEY 超级密钥 + X-AI-Impersonate。

用法：
  export AI_ACCESS_KEY=...
  python3 publish.py --base https://main-prd-agent.miduo.org \
    --impersonate inernoro --title "日报-2026-05-31-今日大事早知道" \
    --daily-date 2026-05-31 --report-md /tmp/daily.md \
    --manifest /tmp/acc_shots/manifest.json   # 可选：harness 产出的截图清单
  # 无密钥 / 无文档空间时退化为本地：
  python3 publish.py --local --title "..." --report-md /tmp/daily.md --out fallback.md \
    --manifest /tmp/acc_shots/manifest.json
"""
import argparse, json, os, subprocess, time, sys, re, shutil

API = "/api/document-store"
STORE_NAME = "日报知识库"
STORE_DESC = "每日开发日报归档（今日大事早知道）。新增方向多讲，优化/修复次之，计划/遗留垫底。"
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
PLACEHOLDER_RE = re.compile(r"\{\{IMG:[^}]+\}\}|\{\{EVIDENCE\}\}")


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
        super_key = os.environ.get("AI_ACCESS_KEY", "").strip()
        if not super_key:
            sys.stderr.write(
                "[错误] 既无 DAILY_DOC_STORE_KEY 也无 AI_ACCESS_KEY，无法鉴权。\n"
                "  请 export AI_ACCESS_KEY=...（或带 document-store:write scope 的 DAILY_DOC_STORE_KEY），\n"
                "  或改用 --local 落本地 md。\n")
            sys.exit(4)
        h = ["-H", f"X-AI-Access-Key: {super_key}",
             "-H", f"X-AI-Impersonate: {impersonate}"]
        print(f"  鉴权：AI 超级密钥 + impersonate={impersonate}")
    if with_json:
        h += ["-H", "Content-Type: application/json"]
    return h


def find_store(base, H, name):
    """分页查找同名库，避免库多时漏在首页之外。"""
    page = 1
    while True:
        res = curl(H + [f"{base}/stores?page={page}&pageSize=100"])
        data = res.get("data", {})
        items = data.get("items", [])
        for s in items:
            if s.get("name") == name:
                return s["id"]
        has_next = data.get("hasNextPage")
        if has_next is False or len(items) < 100:
            return None
        page += 1
        if page > 50:
            return None


def resolve_daily_date(daily_date, title):
    if (daily_date or "").strip():
        return daily_date.strip()
    m = DATE_RE.search(title or "")
    return m.group(1) if m else ""


def load_manifest(path):
    if not path:
        return []
    m = json.load(open(path, encoding="utf-8"))
    for item in m:
        p = item.get("path", "")
        if not os.path.isfile(p):
            raise RuntimeError(f"manifest 截图缺失：{item.get('name', p)} -> {p}")
    return m


def apply_evidence(body, name_to_md):
    """把 {{IMG:<name>}} 换成对应图、{{EVIDENCE}} 换成全部图集中段。"""
    content = body
    for name, md in name_to_md.items():
        content = content.replace("{{IMG:%s}}" % name, md)
    evidence = "\n\n".join(name_to_md.values())
    content = content.replace("{{EVIDENCE}}", evidence)
    return content


def assert_no_placeholder(content):
    """发布前硬闸：正文残留 {{IMG:}}/{{EVIDENCE}} 占位 → 拒发，避免读者看到坏占位。"""
    left = PLACEHOLDER_RE.findall(content)
    if left:
        raise RuntimeError(
            "正文残留未替换的截图占位 " + ", ".join(sorted(set(left))) +
            "：要么传 --manifest 提供对应截图，要么从正文删掉这些占位后再发。")


def run_local(a, body, manifest):
    out = a.out or f"daily-{resolve_daily_date(a.daily_date, a.title) or 'report'}.md"
    name_to_md = {}
    if manifest:
        shot_dir = os.path.splitext(out)[0] + "_shots"
        os.makedirs(shot_dir, exist_ok=True)
        for m in manifest:
            dst = os.path.join(shot_dir, f"{m['name']}.png")
            shutil.copyfile(m["path"], dst)
            cap = m.get("caption", m["name"])
            name_to_md[m["name"]] = f"![{cap}](./{os.path.basename(shot_dir)}/{m['name']}.png)"
            print(f"  拷贝截图 {m['name']} -> {dst}")
    body = apply_evidence(body, name_to_md)
    assert_no_placeholder(body)
    with open(out, "w", encoding="utf-8") as f:
        f.write(body)
    print(json.dumps({"mode": "local", "title": a.title, "reportPath": out,
                      "shots": len(name_to_md)}, ensure_ascii=False))
    print(f"\n===== 日报已落本地 =====\n路径：{out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="", help="环境 base URL，如 https://main-prd-agent.miduo.org（doc-store 模式必填）")
    ap.add_argument("--impersonate", default="inernoro")
    ap.add_argument("--title", required=True)
    ap.add_argument("--report-md", required=True, help="正文 md（以 # 标题打头，可含 {{IMG:<name>}}/{{EVIDENCE}} 占位）")
    ap.add_argument("--daily-date", default="", help="metadata.dailyDate（YYYY-MM-DD）；缺省时从标题提取")
    ap.add_argument("--manifest", default="", help="harness 截图清单 json：[{name,caption,path}]；有截图时必传")
    ap.add_argument("--local", action="store_true", help="不发网络，落本地 md（无密钥/无文档空间时用）")
    ap.add_argument("--out", default="", help="--local 模式输出路径")
    a = ap.parse_args()

    body = open(a.report_md, encoding="utf-8").read().lstrip()
    if not body.startswith("#"):
        body = f"# {a.title}\n\n" + body
    manifest = load_manifest(a.manifest)

    if a.local:
        run_local(a, body, manifest)
        return
    if not a.base:
        sys.stderr.write("[错误] doc-store 模式需要 --base；或改用 --local。\n")
        sys.exit(5)

    base = a.base.rstrip("/") + API
    H = headers(a.impersonate)
    HJ = headers(a.impersonate, with_json=True)

    # find-or-create store（分页查找）
    rid = find_store(base, H, STORE_NAME)
    created_store = False
    if rid:
        print(f"  复用知识库「{STORE_NAME}」id={rid}")
    else:
        rid = curl(HJ + ["-X", "POST", "-d", json.dumps(
            {"name": STORE_NAME, "description": STORE_DESC, "isPublic": False}
        ), f"{base}/stores"])["data"]["id"]
        created_store = True
        print(f"  新建知识库「{STORE_NAME}」id={rid}")

    def rollback_store_if_new():
        if not created_store:
            return
        try:
            curl(H + ["-X", "DELETE", f"{base}/stores/{rid}"], retries=2)
            print(f"  发布失败，已回滚刚建的空库 {rid}（不留空壳库）")
        except Exception:
            print(f"  发布失败且空库 {rid} 回滚也失败；稳定后请手动删该空库")

    # 上传截图（先于建条目，拿到可访问 URL 回填占位），失败回滚新建库
    try:
        name_to_md = {}
        for m in manifest:
            d = curl(H + ["-F", f"file=@{m['path']}", f"{base}/stores/{rid}/upload"])["data"]
            url = d["fileUrl"]
            cap = m.get("caption", m["name"])
            name_to_md[m["name"]] = f"![{cap}]({url})"
            # upload 会建一个文件条目，取 URL 后删掉，避免库里多出图片条目
            try:
                curl(H + ["-X", "DELETE", f"{base}/entries/{d['entry']['id']}"])
            except Exception:
                pass
            print(f"  上传截图 {m['name']} -> {url}")
        body = apply_evidence(body, name_to_md)
        assert_no_placeholder(body)
    except Exception as e:
        print(f"  截图上传/占位回填失败：{str(e)[:140]}")
        rollback_store_if_new()
        raise

    # create entry（失败则回滚新建的库）
    daily_date = resolve_daily_date(a.daily_date, a.title)
    meta = {"kind": "daily-report", "dailyDate": daily_date}
    try:
        eid = curl(HJ + ["-X", "POST", "-d", json.dumps({
            "title": a.title, "summary": f"# {a.title}",
            "sourceType": "reference", "contentType": "text/markdown",
            "tags": ["日报", "今日大事"], "metadata": meta,
        }), f"{base}/stores/{rid}/entries"])["data"]["id"]
    except Exception as e:
        print(f"  建条目失败：{str(e)[:120]}")
        rollback_store_if_new()
        raise
    print(f"  条目 id={eid} title={a.title} dailyDate={daily_date} shots={len(manifest)}")

    # write content + verify hasContent（空壳兜底）
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
        rollback_store_if_new()
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
