#!/usr/bin/env python3
"""MAP 验收 · 报告归档（项目无关，配置驱动，双模式）。

两种输出模式（由 acceptance.config.json 的 report.mode 决定）：
  - doc-store：上传截图 → 删图条目(保URL) → 找/建报告库 → 建条目(正文以 # 标题
    打头,根治目录 `---`) → 写正文 → 出分享短链。需要文档空间 API + AI 密钥。
  - local：把报告写成本地 md + 截图拷到本地目录，图用相对路径引用。**零依赖**，
    适合没有文档空间的仓库。

用法：
  python3 archive_report.py \
    --config <acceptance.config.json> \
    --target "知识库订阅保存双通道" \
    --verdict pass --tier L2 \
    --report-md <报告正文.md，速览卡+九段，正文里用 {{EVIDENCE}} 占位> \
    --manifest <harness 产出的 manifest.json：[{name,caption,path}]> \
    [--branch xxx --commit xxx]

依赖 env（仅 doc-store 模式）：见 config.auth.api（默认 AI_ACCESS_KEY + MAP_AI_USER）。
local 模式不读任何 env、不发任何网络请求。
"""
import argparse, json, os, subprocess, datetime, re, shutil, time


def curl(args, retries=3):
    """带超时 + 重试。网关 524/超时等瞬时故障会重试（GET/PUT 幂等安全）。"""
    last = ""
    for i in range(retries):
        r = subprocess.run(["curl", "-s", "--max-time", "150"] + args, capture_output=True, text=True)
        last = r.stdout
        try:
            return json.loads(r.stdout)
        except Exception:
            # 非 JSON（如 Cloudflare "error code: 524" / 空）→ 退避重试
            if i < retries - 1:
                time.sleep(2 * (i + 1)); continue
    print("RAW(重试后仍失败):", (last or "")[:300]); raise RuntimeError("curl 返回非 JSON")


def preview_from_cmd(cmd):
    """cdscli 可能在超时时往 stdout 打 [warn] 行 → 取最后一非空行作为 URL。"""
    out = subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    return lines[-1] if lines else ""


def slugify(s):
    s = re.sub(r"[^a-z0-9一-鿿]+", "-", s.lower()).strip("-")
    return s[:40] or "report"


def build_meta(report_id, now, reviewer, a, preview):
    return (
        "\n\n<!-- acceptance-meta\n"
        "type: acceptance-report\nstandard: MAP-Acceptance-v2\n"
        f"report_id: {report_id}\ndate: {now.strftime('%Y-%m-%d')}\n"
        f"reviewer: {reviewer}\nverdict: {a.verdict}\ntier: {a.tier}\n"
        f"target_ref: {a.target}\npreview_url: {preview}\n"
        f"branch: {a.branch}\ncommit: {a.commit}\n-->\n"
    )


def assemble(title, body, evidence, meta):
    """正文以 H1 标题打头（根治目录 `---`，见标准 §2.1），机读字段在文末注释。"""
    return f"# {title}\n\n" + body.replace("{{EVIDENCE}}", evidence) + meta


def run_local(cfg, a, title, report_id, body, manifest, meta):
    out_dir = cfg["report"].get("localOutDir", "doc/acceptance")
    os.makedirs(out_dir, exist_ok=True)
    shot_dir = os.path.join(out_dir, report_id)
    os.makedirs(shot_dir, exist_ok=True)
    evid_parts = []
    for m in manifest:
        dst = os.path.join(shot_dir, f"{m['name']}.png")
        shutil.copyfile(m["path"], dst)
        rel = f"./{report_id}/{m['name']}.png"
        evid_parts.append(f"**{m['caption']}**\n\n![{m['caption']}]({rel})")
        print(f"  拷贝截图 {m['name']} -> {dst}")
    content = assemble(title, body, "\n\n".join(evid_parts), meta)
    md_path = os.path.join(out_dir, f"{report_id}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(json.dumps({"mode": "local", "title": title, "report_id": report_id,
                      "reportPath": md_path, "shotsDir": shot_dir}, ensure_ascii=False))


def run_doc_store(cfg, a, title, report_id, body, manifest, now, preview):
    api = cfg["auth"]["api"]
    key = os.environ[api["keyEnv"]]
    imp = os.environ[api["impersonateEnv"]]
    H = ["-H", f"{api['keyHeader']}: {key}", "-H", f"{api['impersonateHeader']}: {imp}"]
    HJ = H + ["-H", "Content-Type: application/json"]
    base = preview.rstrip("/") + cfg["report"]["apiBasePath"]

    store_name = cfg["report"]["storeName"]
    stores = curl(H + [f"{base}/stores?pageSize=100"])["data"]["items"]
    match = [s for s in stores if s["name"] == store_name]
    rid = match[0]["id"] if match else curl(HJ + ["-X", "POST", "-d", json.dumps(
        {"name": store_name, "description": cfg["report"].get("storeDescription", ""),
         "isPublic": bool(cfg["report"].get("isPublic", False))}
    ), f"{base}/stores"])["data"]["id"]
    print(f"  报告库 id={rid}")

    url_map = {}
    for m in manifest:
        d = curl(H + ["-F", f"file=@{m['path']}", f"{base}/stores/{rid}/upload"])["data"]
        url_map[m["name"]] = d["fileUrl"]
        curl(H + ["-X", "DELETE", f"{base}/entries/{d['entry']['id']}"])
        print(f"  上传+清理 {m['name']} -> {d['fileUrl']}")

    evidence = "\n\n".join(f"**{m['caption']}**\n\n![{m['caption']}]({url_map[m['name']]})" for m in manifest)
    meta = build_meta(report_id, now, imp, a, preview)
    content = assemble(title, body, evidence, meta)

    eid = curl(HJ + ["-X", "POST", "-d", json.dumps({
        "title": title, "summary": f"# {title}",  # 双保险:summary 也以标题打头
        "sourceType": "reference", "contentType": "text/markdown",
    }), f"{base}/stores/{rid}/entries"])["data"]["id"]
    print(f"  报告条目 id={eid} title={title}")
    w = curl(HJ + ["-X", "PUT", "-d", json.dumps({"content": content}), f"{base}/entries/{eid}/content"])
    print(f"  写正文 success={w.get('success')}")
    tok = curl(HJ + ["-X", "POST", "-d", json.dumps({"title": title, "expiresInDays": 0}),
                     f"{base}/stores/{rid}/share-links"])["data"]["token"]
    print(json.dumps({
        "mode": "doc-store", "title": title, "report_id": report_id, "entryId": eid, "storeId": rid,
        "ownerView": "登录后 知识库 → 「" + store_name + "」库 → 本篇（授权路径,正文+截图完整渲染,主交付）",
        "shareUrl": f"{preview.rstrip('/')}/library/share/{tok}",
        "shareNote": "share 链接当前只渲染目录、不渲染正文（分享阅读器已知缺陷）;交给第三方请让其登录或设 report.isPublic=true",
    }, ensure_ascii=False))


# ── 准入门槛（入口准则，见 standard-v2.md §3.5）：输入不达标直接拒收 ──
TIER_MIN_SHOTS = {"L0": 1, "L1": 3, "L2": 5}
JUNK_TARGETS = {"test", "测试", "xxx", "demo", "tmp", "临时", "aaa", "todo"}
PLACEHOLDER_PAT = re.compile(r"\{YYYY|\{target\}|\{project\}|\{verdict|\{date\}|\{commit\}|\{branch\}|\{sha\}|\{url\}|\{\{(?!EVIDENCE\}\})")


def validate_inputs(a, body, manifest):
    """返回拒收原因列表（空 = 通过准入）。结构层校验，语义层(Verdict 一致性)由人/工具把关。"""
    errs = []
    t = (a.target or "").strip()
    if len(t) < 4 or t.lower() in JUNK_TARGETS:
        errs.append(f"[目标] 无意义或太短：{a.target!r}（需 ≥4 字且非占位垃圾）")
    if a.tier not in TIER_MIN_SHOTS:
        errs.append(f"[档位] 非法：{a.tier}（应为 L0/L1/L2）")
    if a.verdict not in {"pass", "conditional", "fail"}:
        errs.append(f"[Verdict] 非法：{a.verdict}（应为 pass/conditional/fail）")
    need = TIER_MIN_SHOTS.get(a.tier, 3)
    if len(manifest) < need:
        errs.append(f"[证据] 截图数 {len(manifest)} < {a.tier} 下限 {need}")
    for m in manifest:
        p = m.get("path", "")
        if not os.path.isfile(p) or os.path.getsize(p) < 1024:
            errs.append(f"[证据] 截图缺失/过小(<1KB)：{m.get('name', p)}")
        if not (m.get("caption") or "").strip():
            errs.append(f"[证据] 截图无 caption：{m.get('name', p)}")
    for kw, label in [("Verdict", "Verdict 行"), ("用例", "验收用例段"), ("缺陷", "缺陷清单段")]:
        if kw not in body:
            errs.append(f"[结构] 报告缺{label}")
    if "{{EVIDENCE}}" not in body:
        errs.append("[结构] 报告缺 {{EVIDENCE}} 占位（截图无处内联）")
    if PLACEHOLDER_PAT.search(body):
        errs.append("[半成品] 报告含未替换模板占位（{xxx} / 裸 {{）")
    for kw in ("TODO", "待填", "待补"):
        if kw in body:
            errs.append(f"[半成品] 报告含未完成标记：{kw}")
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--verdict", default="pass")
    ap.add_argument("--tier", default="L1")
    ap.add_argument("--report-md", required=True, help="正文 md（速览卡+九段，{{EVIDENCE}} 占位）")
    ap.add_argument("--manifest", required=True, help="截图清单 json：[{name,caption,path}]")
    ap.add_argument("--branch", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--force", action="store_true", help="越过准入校验（仅在确知合理时用，会打印告警）")
    a = ap.parse_args()

    cfg = json.load(open(a.config))
    mode = cfg.get("report", {}).get("mode", "doc-store")
    now = datetime.datetime.now()
    dt = now.strftime(cfg["report"].get("datetimeFormat", "%Y-%m-%d %H:%M"))
    verdict_cn = {"pass": "通过", "conditional": "有条件通过", "fail": "不通过"}.get(a.verdict, a.verdict)
    title = cfg["report"]["naming"].format(
        project=cfg["project"], datetime=dt, date=now.strftime("%Y-%m-%d"),
        target=a.target, verdict_cn=verdict_cn)
    report_id = f"acc-{cfg['project']}-{now.strftime('%Y%m%d%H%M')}-{slugify(a.target)}"
    body = open(a.report_md, encoding="utf-8").read().lstrip()
    manifest = json.load(open(a.manifest))

    # 准入校验：不达标直接拒收，不写库（--force 越权但告警）
    errs = validate_inputs(a, body, manifest)
    if errs:
        head = "准入校验未通过，已拒收（输入不对，输出不可能对）：" if not a.force else "准入校验未通过，但 --force 强行继续："
        print(head)
        for e in errs:
            print("  - " + e)
        if not a.force:
            import sys as _sys; _sys.exit(2)

    preview = (cfg.get("previewUrlOverride") or "").strip()
    if not preview and mode == "doc-store":
        preview = preview_from_cmd(cfg["previewUrlCmd"])

    if mode == "local":
        run_local(cfg, a, title, report_id, body, manifest, build_meta(report_id, now, "local", a, preview))
    else:
        run_doc_store(cfg, a, title, report_id, body, manifest, now, preview)


if __name__ == "__main__":
    main()
