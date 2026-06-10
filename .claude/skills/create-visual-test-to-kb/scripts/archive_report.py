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


def curl(args, retries=5):
    """带超时 + 重试。网关 524/超时等瞬时故障会退避重试（GET/PUT 幂等安全）。"""
    last = ""
    for i in range(retries):
        r = subprocess.run(["curl", "-s", "--max-time", "150"] + args, capture_output=True, text=True)
        last = r.stdout
        try:
            return json.loads(r.stdout)
        except Exception:
            # 非 JSON（如 Cloudflare "error code: 524" / 空 / 预览环境准备中）→ 退避重试
            if i < retries - 1:
                time.sleep(3 * (i + 1)); continue
    print("RAW(重试后仍失败):", (last or "")[:200]); raise RuntimeError("curl 返回非 JSON（多为预览环境 524/重启）")


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


def assemble(title, body, evidence, meta, img_md=None):
    """正文以 H1 标题打头（根治目录 `---`，见标准 §2.1），机读字段在文末注释。
    支持两种图片占位：
      - {{IMG:<截图name>}} —— ZZ 照做风：把该步截图内联到此处（文字在上图在下，逐步配图）
      - {{EVIDENCE}}       —— 旧版：把所有截图集中堆到此处（§9 证据段）
    """
    content = body
    if img_md:
        for name, md in img_md.items():
            content = content.replace("{{IMG:%s}}" % name, md)
    return f"# {title}\n\n" + content.replace("{{EVIDENCE}}", evidence) + meta


def run_local(cfg, a, title, report_id, body, manifest, meta, tags=None):
    out_dir = cfg["report"].get("localOutDir", "doc/acceptance")
    os.makedirs(out_dir, exist_ok=True)
    shot_dir = os.path.join(out_dir, report_id)
    os.makedirs(shot_dir, exist_ok=True)
    evid_parts, img_md = [], {}
    for m in manifest:
        dst = os.path.join(shot_dir, f"{m['name']}.png")
        shutil.copyfile(m["path"], dst)
        rel = f"./{report_id}/{m['name']}.png"
        evid_parts.append(f"**{m['caption']}**\n\n![{m['caption']}]({rel})")
        img_md[m["name"]] = f"![{m['caption']}]({rel})"
        print(f"  拷贝截图 {m['name']} -> {dst}")
    content = assemble(title, body, "\n\n".join(evid_parts), meta, img_md)
    md_path = os.path.join(out_dir, f"{report_id}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(json.dumps({"mode": "local", "title": title, "report_id": report_id,
                      "reportPath": md_path, "shotsDir": shot_dir}, ensure_ascii=False))


def run_doc_store(cfg, a, title, report_id, body, manifest, now, preview, tags=None):
    api = cfg["auth"]["api"]
    # 简便方式（推荐）：设 MAP_DOC_STORE_KEY=sk-ak-...（带 document-store:write scope 的最小权限长效 Key），
    # 走 Authorization: Bearer，无需 impersonate、无需 AI 超级密钥。
    # 未设时回退 AI 超级密钥 + X-AI-Impersonate（向后兼容）。
    agent_key_env = api.get("agentKeyEnv", "MAP_DOC_STORE_KEY")
    agent_key = os.environ.get(agent_key_env, "").strip()
    if agent_key:
        H = ["-H", f"Authorization: Bearer {agent_key}"]
        imp = os.environ.get(api.get("impersonateEnv", ""), "") or "(scoped-key-owner)"
        print(f"  鉴权：AgentApiKey scope（{agent_key_env}，最小权限 document-store:write）")
    else:
        key = os.environ[api["keyEnv"]]
        imp = os.environ[api["impersonateEnv"]]
        H = ["-H", f"{api['keyHeader']}: {key}", "-H", f"{api['impersonateHeader']}: {imp}"]
        print("  鉴权：AI 超级密钥 + impersonate（建议改用 MAP_DOC_STORE_KEY scoped key）")
    HJ = H + ["-H", "Content-Type: application/json"]
    base = preview.rstrip("/") + cfg["report"]["apiBasePath"]

    store_name = cfg["report"]["storeName"]
    want_public = bool(cfg["report"].get("isPublic", False))
    want_template = cfg["report"].get("templateKey")
    stores = curl(H + [f"{base}/stores?pageSize=100"])["data"]["items"]
    match = [s for s in stores if s["name"] == store_name]
    if match:
        rid = match[0]["id"]
        # 防可见性漂移：复用到的库若 isPublic 与 config 不符就告警。
        # 殿堂(isPublic=true,对所有人) ≠ 分享(token,对部分人)——验收报告默认私有,别让它悄悄公开进殿堂。
        cur_public = bool(match[0].get("isPublic"))
        if cur_public != want_public:
            print(f"  [告警] 复用库「{store_name}」isPublic={cur_public}，但 config 要 {want_public}："
                  + ("该库当前公开在殿堂(对所有人可见)，验收报告通常应私有；如非本意请把库设私有后重跑。"
                     if cur_public else "config 想公开但库是私有；如需进殿堂请手动设公开。"))
        # 补 templateKey：早就存在的库（find-or-create 复用）可能缺 templateKey，
        # 导致前端排序退化为字典序、最新报告不在最前。缺了就补，让 created-desc 生效。
        if want_template and match[0].get("templateKey") != want_template:
            curl(HJ + ["-X", "PUT", "-d", json.dumps({"templateKey": want_template}), f"{base}/stores/{rid}"])
            print(f"  复用库缺 templateKey，已补设为 {want_template}（让最新报告排最前）")
    else:
        rid = curl(HJ + ["-X", "POST", "-d", json.dumps(
            {"name": store_name, "description": cfg["report"].get("storeDescription", ""),
             "isPublic": want_public,
             # 模板键：让"验收报告库"对写入条目做结构约束（design.acceptance-kb.md §5.B）。
             # 机器归档缺必填 metadata/正文 section 会被后端 422 拒收。
             "templateKey": want_template}
        ), f"{base}/stores"])["data"]["id"]
    print(f"  报告库 id={rid}")

    url_map = {}
    for m in manifest:
        d = curl(H + ["-F", f"file=@{m['path']}", f"{base}/stores/{rid}/upload"])["data"]
        url_map[m["name"]] = d["fileUrl"]
        curl(H + ["-X", "DELETE", f"{base}/entries/{d['entry']['id']}"])
        print(f"  上传+清理 {m['name']} -> {d['fileUrl']}")

    evidence = "\n\n".join(f"**{m['caption']}**\n\n![{m['caption']}]({url_map[m['name']]})" for m in manifest)
    img_md = {m["name"]: f"![{m['caption']}]({url_map[m['name']]})" for m in manifest}
    meta = build_meta(report_id, now, imp, a, preview)
    content = assemble(title, body, evidence, meta, img_md)

    # metadata：结论可视(前端按 verdict 渲染绿/琥珀/红徽章) + 跨环境同步幂等(reportId 去重)。
    # kind=acceptance-report 让后端模板校验对本次写入"硬卡"(缺项 422 而非软放行)。
    entry_meta = {
        "kind": "acceptance-report",
        "verdict": a.verdict,          # pass / conditional / fail
        "tier": a.tier,                # L0 / L1 / L2
        "target": a.target,
        "reportId": report_id,
        "acceptedAt": now.isoformat(timespec="seconds"),
    }
    # 报告平铺在库根级（不自动分子文件夹）：用户最看重"最新报告一眼可见"，
    # 配合库的 created-desc 排序，新报告永远在最顶。曾经按模块自动建子文件夹，
    # 反而把最新报告藏进文件夹、与"最新最前"打架，已撤销。
    # （原始诉求 Q5 问的是"验收报告是否独立成库"，是库级隔离，不是库内再分子文件夹。）
    eid = curl(HJ + ["-X", "POST", "-d", json.dumps({
        "title": title, "summary": f"# {title}",  # 双保险:summary 也以标题打头
        "sourceType": "reference", "contentType": "text/markdown",
        "tags": tags or [],  # 状态(通过/不通过)+操作方式+档位走标签，不进标题
        "metadata": entry_meta,
    }), f"{base}/stores/{rid}/entries"])["data"]["id"]
    print(f"  报告条目 id={eid} title={title} tags={tags or []}")
    # 防「断头报告」：标题建了但 PUT 524 丢了正文 → 留下能看到标题、点开却空白的空壳条目。
    # PUT 本身可能 524 抛错（curl 重试耗尽），也可能返回了但正文没落库 → 两种都得兜住：
    # 强制校验 hasContent，写不进就删掉空壳 + 报错，绝不留半截。
    def _has_content():
        try:
            return bool(curl(H + [f"{base}/entries/{eid}/content"], retries=2).get("data", {}).get("hasContent"))
        except Exception:
            return False
    ok = False
    try:
        w = curl(HJ + ["-X", "PUT", "-d", json.dumps({"content": content}), f"{base}/entries/{eid}/content"])
        print(f"  写正文 success={w.get('success')}")
        ok = _has_content()
        if not ok:  # 返回了但没落库 → 再写一次
            curl(HJ + ["-X", "PUT", "-d", json.dumps({"content": content}), f"{base}/entries/{eid}/content"])
            ok = _has_content()
    except Exception as e:  # PUT 抛错（524 重试耗尽）；先确认是否其实写进去了
        print(f"  写正文异常：{str(e)[:120]}")
        ok = _has_content()
    if not ok:
        try:
            curl(H + ["-X", "DELETE", f"{base}/entries/{eid}"], retries=2)
            print(f"  正文写入未生效，已删除空壳条目 {eid}（不留断头报告）")
        except Exception:
            print(f"  正文写入未生效，且空壳条目 {eid} 删除也失败（预览环境不可达）；稳定后请手动删该空条目")
        raise RuntimeError("正文写入未生效(hasContent=false)：多为预览环境 524/重启，已尝试删除空壳条目，请稍后重跑")
    print("  正文已校验落库 hasContent=true")
    # E1 强制分享链：条目已建=归档成功；分享链单独 try，失败也给 owner 路径，绝不静默
    owner_view = "登录后 知识库 → 「" + store_name + "」库 → 本篇（授权路径,正文+截图完整渲染,本人验收用）"
    share_url = None
    try:
        tok = curl(HJ + ["-X", "POST", "-d", json.dumps({"title": title, "expiresInDays": 0}),
                         f"{base}/stores/{rid}/share-links"])["data"]["token"]
        # 正确路由(实测 2026-05-27)：App.tsx 是 /s/lib/:token，旧 /library/share/ 会落到首页。
        # 带 ?entry={eid}(2026-05-28)：让分享对象一打开就高亮本次归档的新报告，不用在目录里翻找。
        # LibraryShareViewPage 读 useSearchParams('entry')，优先级最高(高于 view.entryId / primaryEntryId / 最新创建)。
        share_url = f"{preview.rstrip('/')}/s/lib/{tok}?entry={eid}"
    except Exception as e:
        print("  分享链生成失败（可登录后在该库手动分享）：", str(e)[:120])
    print(json.dumps({
        "mode": "doc-store", "title": title, "report_id": report_id, "entryId": eid, "storeId": rid,
        "ownerView": owner_view, "shareUrl": share_url,
        "shareNote": "分享链 /s/lib/{token} 对部分人(拿到链接者)开放、库私有也能看(token 独立授权)，已实测渲染正文+截图;这不是殿堂(殿堂=isPublic=true 对所有人公开)，验收报告默认私有不进殿堂",
    }, ensure_ascii=False))
    # 醒目收尾：每次必给一个可达地址（分享链=对部分人，优先；owner 自看兜底；殿堂不作默认）
    print("\n===== 验收归档完成 · 必给地址 =====")
    print("分享链（对部分人，拿到链接即可看，库私有也行）：" + (share_url if share_url else "（分享接口超时未拿到；请登录后在该库「" + store_name + "」手动生成分享，或稍后重跑）"))
    print("Owner 自看（登录可达）：" + owner_view)
    print("注：分享≠殿堂。殿堂是 isPublic=true 对所有人公开，验收报告默认私有不进殿堂。")


# ── 准入门槛（入口准则，见 standard-v2.md §3.5）：输入不达标直接拒收 ──
TIER_MIN_SHOTS = {"L0": 1, "L1": 3, "L2": 5}
JUNK_TARGETS = {"test", "测试", "xxx", "demo", "tmp", "临时", "aaa", "todo"}
PLACEHOLDER_PAT = re.compile(r"\{YYYY|\{target\}|\{project\}|\{verdict|\{date\}|\{commit\}|\{branch\}|\{sha\}|\{url\}|\{\{(?!EVIDENCE\}\}|IMG:)")


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
        cap = (m.get("caption") or "").strip()
        nm = (m.get("name") or "").strip()
        if not cap:
            errs.append(f"[证据] 截图无 caption：{m.get('name', p)}")
        elif cap == nm or len(cap) < 6:
            # 落实 SKILL「取证选材与标注」§B：caption 必须写清"验证了什么"，
            # 只写名字 / 过短（如「首页截图」「AI 大事」）一律拒收，不能蒙混成合规证据。
            errs.append(f"[证据] caption 太弱（只写名字/过短，需写清验证点）：{m.get('name', p)} -> {cap!r}")
        # v2.2: harness 在截图前后做了就绪等待 + 内容校验，把 warning 写进 manifest；
        # 这里把 warning 提升为拒收硬条件，让"页面没加载完就拍"无法蒙混过关。
        ws = m.get("warnings") or []
        if ws:
            errs.append(f"[证据] 截图未就绪/有问题：{m.get('name', p)} → {' | '.join(ws)}")
        # §B2 标注硬门禁(2026-06-05)：指向性证据图截图瞬间必须有 box/circle 标记。
        # harness.shot() 自动探测页面上的 .__acc_box → 落进 manifest 的 annotated 字段。
        # `is False` 而非 falsy：老 manifest 无此字段(None)→不追溯拒收；只有新 harness 明确记为
        # 未标注(False)且非 overview 才拒收。根治"证据是没标注的裸页面、读者看到一个单独页面就懵逼"
        # (用户 2026-06-05：技能这么多次给没标注的截图)。整体观感图调用方传 overview=true 豁免。
        if m.get("annotated") is False and not m.get("overview"):
            errs.append(f"[证据·未标注] 没画框/圈，读者不知道看哪：{m.get('name', p)}。"
                        f"指向单个按钮/输入框用圈(stepClick / box(...,{{shape:'circle'}}))、"
                        f"框一片区域/差异用方框(stepShot(...,highlight))；纯整体观感图传 {{overview:true}} 豁免")
    for kw, label in [("Verdict", "Verdict 行"), ("用例", "验收用例段"), ("缺陷", "缺陷清单段")]:
        if kw not in body:
            errs.append(f"[结构] 报告缺{label}")
    # v2.1 强制：需求一一对应表（避免"用户提了 10 条只对应 6 条"的茫然，详见 standard-v2.md §6.4）
    if "需求一一对应表" not in body:
        errs.append("[结构] 报告缺「需求一一对应表」标题（v2.1 强制，详见 standard-v2.md §6.4）")
    if "{{EVIDENCE}}" not in body and "{{IMG:" not in body:
        errs.append("[结构] 报告缺截图占位：{{EVIDENCE}}（集中证据段）或 {{IMG:<name>}}（ZZ 逐步配图）至少要有一种")
    if PLACEHOLDER_PAT.search(body):
        errs.append("[半成品] 报告含未替换模板占位（{xxx} / 裸 {{）")
    for kw in ("TODO", "待填", "待补"):
        if kw in body:
            errs.append(f"[半成品] 报告含未完成标记：{kw}")

    # ── v2.3 证据链连线（2026-06-10，用户指出「问题原因和结果截图完全不同/有些完全没有连线」后新增）──
    # 1) 正文 {{IMG:name}} 必须能连回 manifest（防图文脱节）
    # 2) 「验收用例」表里状态为 pass 的行，证据列必须引用真实截图（「图XX」且 manifest 有以 XX 开头的图）；
    #    「文字记录 / 无 / N.A.」一律拒收——没有图的断言不允许进 pass 报告。
    mani_names = [(m.get("name") or "").strip() for m in manifest]
    for ph in re.findall(r"\{\{IMG:([^}]+)\}\}", body):
        if ph.strip() not in mani_names:
            errs.append(f"[断链] 正文引用 {{{{IMG:{ph.strip()}}}}} 不在 manifest（图文脱节）")
    in_case_table = False
    for line in body.splitlines():
        ls = line.strip()
        if ls.startswith("#"):
            in_case_table = "验收用例" in ls
            continue
        if not in_case_table or not ls.startswith("|"):
            continue
        cells = [c.strip() for c in ls.strip("|").split("|")]
        if len(cells) < 3 or not any(c.lower() == "pass" for c in cells):
            continue  # 表头/分隔行/非 pass 行不查
        evidence = cells[-1]
        if re.fullmatch(r"(文字记录|文字断言|日志|无|—|-{1,3}|N/?\.?A\.?)?", evidence, re.I):
            errs.append(f"[断链] pass 用例无图证据（证据列={evidence!r}），无图断言不得 pass：{ls[:70]}")
            continue
        refs = re.findall(r"图\s*([0-9]+[a-zA-Z]?)", evidence)
        if not refs:
            errs.append(f"[断链] pass 用例证据列未引用截图（需「图XX」连到 manifest）：{ls[:70]}")
        else:
            for r0 in refs:
                if not any(n.lower().startswith(r0.lower()) for n in mani_names):
                    errs.append(f"[断链] pass 用例引用「图{r0}」但 manifest 无以 {r0} 开头的截图：{ls[:70]}")
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--module", default="", help="模块（命名第2段，如 网页托管 / 知识库）")
    ap.add_argument("--feature", default="", help="功能（命名第3段，如 SaaS空间模型；缺省用 --target）")
    ap.add_argument("--type", default="", help="操作方式（命名第4段，如 新增功能 / 优化 / 修复）")
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
    # 命名固定结构：项目 · 模块 · 功能 · 操作方式 · 验收报告（用户定，2026-05-27）。
    # verdict（通过/不通过）不进标题——走 tags 标记，不靠改名表达状态。空段自动跳过。
    segs = [s for s in [cfg["project"], a.module, (a.feature or a.target), a.type] if (s or "").strip()]
    title = " · ".join(segs) + " · 验收报告"
    # 标签：状态 + 操作方式 + 档位（取代旧的「标题前缀 [通过]」）
    tags = [t for t in [verdict_cn, a.type, a.tier] if (t or "").strip()]
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

    try:
        if mode == "local":
            run_local(cfg, a, title, report_id, body, manifest, build_meta(report_id, now, "local", a, preview), tags)
        else:
            run_doc_store(cfg, a, title, report_id, body, manifest, now, preview, tags)
    except Exception as e:
        import sys as _sys
        print("\n[归档失败] 写库未完成（常见原因：预览环境 524 / 容器重启 / API 不可达）。")
        print("  原因：" + str(e)[:200])
        print("  报告正文与截图已就绪；待预览环境稳定后用同样命令重跑即可（生成新 report_id）。")
        _sys.exit(3)


if __name__ == "__main__":
    main()
