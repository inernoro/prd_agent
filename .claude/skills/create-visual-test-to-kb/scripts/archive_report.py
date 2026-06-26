#!/usr/bin/env python3
"""验收 · 报告归档（项目无关，配置驱动）。

职责分离（2026-06-25）：验收能力归 CDS 验收中心，技能不再分流到 MAP 知识库。
报告永远按项目入库 CDS；MAP 等系统通过知识库开放协议（peer-sync）从 CDS 拉取展示。

三种输出模式（由 acceptance.config.json 的 report.mode 决定，缺省 = cds）：
  - cds（默认主路）：自包含 markdown（截图内联 data-URI）→ POST /api/reports，
    按项目 + 文件夹归类，带 verdict / tier / 部署上下文元数据 → 出 /reports 直达深链。
    依赖 env：CDS_HOST + (CDS_PROJECT_KEY 或 AI_ACCESS_KEY)。
  - local：把报告写成本地 md + 截图拷到本地目录，图用相对路径引用。**零依赖**，
    适合没有 CDS / 离线兜底。
  - doc-store（向后兼容，不推荐）：旧 MAP 知识库路径，仅当 config 显式保留 mode=doc-store 才走。

用法：
  python3 archive_report.py \
    --config <acceptance.config.json> \
    --target "知识库订阅保存双通道" \
    --verdict pass --tier L2 \
    --report-md <报告正文.md，速览卡+九段，正文里用 {{EVIDENCE}} 占位> \
    --manifest <harness 产出的 manifest.json：[{name,caption,path}]> \
    [--branch xxx --commit xxx --pr 922]
"""
import argparse, json, os, subprocess, datetime, re, shutil, time, base64, tempfile
from pathlib import Path

LOCAL_DEFAULT_OUT_DIR = "/tmp/map-acceptance-local"


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


def curl_json(headers, method, url, payload, retries=5):
    """通过临时文件发送 JSON，避免截图 base64 过大触发系统 argv 长度限制。"""
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as f:
        json.dump(payload, f, ensure_ascii=False)
        tmp = f.name
    try:
        return curl(headers + ["-H", "Content-Type: application/json", "-X", method, "--data-binary", f"@{tmp}", url], retries=retries)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def data_or_raise(resp, context):
    if not isinstance(resp, dict) or not resp.get("success", True):
        raise RuntimeError(f"{context} 失败：{json.dumps(resp, ensure_ascii=False)[:500]}")
    if "data" not in resp or resp.get("data") is None:
        raise RuntimeError(f"{context} 响应缺少 data：{json.dumps(resp, ensure_ascii=False)[:500]}")
    return resp["data"]


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


def repo_root():
    try:
        out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True, stderr=subprocess.DEVNULL).strip()
        return Path(out).resolve() if out else None
    except Exception:
        return None


def is_inside_repo(path, root=None):
    if os.environ.get("ALLOW_REPO_ACCEPTANCE_ARTIFACTS") == "1":
        return False
    root = root or repo_root()
    if not root:
        return False
    try:
        Path(path).resolve().relative_to(root)
        return True
    except Exception:
        return False


def artifact_path_errors(manifest, cfg=None):
    errs = []
    root = repo_root()
    for m in manifest:
        p = m.get("path", "")
        if p and is_inside_repo(p, root):
            errs.append(f"[证据文件位置] 截图位于代码库内：{Path(p).resolve()}。验收截图必须写到 /tmp、对象存储或知识库,不得进入 git diff")
    if cfg and cfg.get("report", {}).get("mode") == "local":
        out_dir = cfg.get("report", {}).get("localOutDir") or LOCAL_DEFAULT_OUT_DIR
        if is_inside_repo(out_dir, root):
            errs.append(f"[本地输出位置] localOutDir 位于代码库内：{Path(out_dir).resolve()}。local 模式默认应写 /tmp/map-acceptance-local")
    return errs


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


# ── CDS 验收中心（默认主路，职责分离：验收能力归 CDS，MAP 走开放协议消费）──
CDS_REPORT_CAP = 10 * 1024 * 1024  # 与 cds/src/routes/reports.ts MAX_CONTENT_BYTES 对齐


def _cds_base():
    host = os.environ.get("CDS_HOST", "").strip().rstrip("/")
    if not host:
        raise RuntimeError("CDS_HOST 未设置（export CDS_HOST=cds.miduo.org）")
    if not host.startswith("http"):
        host = "https://" + host
    return host


def _cds_auth_headers():
    """与 cdscli._auth_headers 一致：项目级 cdsp_* 优先，否则全局 AI_ACCESS_KEY。"""
    pk = os.environ.get("CDS_PROJECT_KEY", "").strip()
    if pk:
        return ["-H", f"X-AI-Access-Key: {pk}"]
    ak = os.environ.get("AI_ACCESS_KEY", "").strip()
    if not ak:
        raise RuntimeError("缺少 CDS 凭据（CDS_PROJECT_KEY 或 AI_ACCESS_KEY）")
    return ["-H", f"X-AI-Access-Key: {ak}"]


def _cds_call(method, path, payload=None):
    H = _cds_auth_headers()
    url = _cds_base() + path
    if payload is not None:
        return curl_json(H, method, url, payload)
    return curl(H + ["-X", method, url])


def _cds_resolve_project(cfg):
    """CDS 项目 ID：config.report.cdsProjectId > env CDS_PROJECT_ID > config.project（项目身份 slug）。
    解析不到时返回 None（归到 CDS 自身 / 全局，仍可入库）。"""
    rep = cfg.get("report", {})
    pid = (rep.get("cdsProjectId") or os.environ.get("CDS_PROJECT_ID") or cfg.get("project") or "").strip()
    return pid or None


def _cds_find_or_create_folder(project_id, folder_name):
    """按名字 find-or-create 项目下的**根级**验收文件夹，返回 folderId 或 None。
    只在根级（parentId 为空）匹配 —— 本函数只建根级文件夹，若按名字匹配到同名的嵌套子
    文件夹会把报告误归到错误层级（Cursor Bugbot Medium）。需要嵌套路径走 --folder-path。"""
    name = (folder_name or "").strip()
    if not name:
        return None
    qs = f"?projectId={project_id}" if project_id else ""
    listing = _cds_call("GET", "/api/report-folders" + qs)
    folders = listing.get("folders", []) if isinstance(listing, dict) else []
    for f in folders:
        if f.get("name") == name and not f.get("parentId"):
            return f.get("id")
    created = _cds_call("POST", "/api/report-folders", {"name": name, "projectId": project_id})
    folder = created.get("folder") if isinstance(created, dict) else None
    return (folder or {}).get("id")


def run_cds(cfg, a, title, report_id, body, manifest, now, tags=None):
    """职责分离主路：把验收报告（自包含 markdown，截图内联 data-URI）入库到 CDS 验收中心。
    报告永远按项目归类；MAP 等系统通过知识库开放协议（peer-sync）从 CDS 拉取展示。"""
    project_id = _cds_resolve_project(cfg)
    folder_id = None
    try:
        folder_id = _cds_find_or_create_folder(project_id, cfg.get("report", {}).get("cdsFolder"))
    except Exception as e:
        print(f"  [告警] 文件夹归类失败（报告仍会入库到项目根）：{str(e)[:120]}")

    # 自包含 markdown：截图内联为 data-URI（CDS format=md 前端渲染 + 净化）。
    evid_parts, img_md = [], {}
    for m in manifest:
        with open(m["path"], "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        uri = f"data:image/png;base64,{data}"
        evid_parts.append(f"**{m['caption']}**\n\n![{m['caption']}]({uri})")
        img_md[m["name"]] = f"![{m['caption']}]({uri})"
        print(f"  内联截图 {m['name']} ({os.path.getsize(m['path'])}B)")
    meta = build_meta(report_id, now, "cds", a, "")
    content = assemble(title, body, "\n\n".join(evid_parts), meta, img_md)
    size = len(content.encode("utf-8"))
    if size > CDS_REPORT_CAP:
        raise RuntimeError(
            f"报告自包含正文 {size/1048576:.1f}MB 超 CDS 10MB 上限。"
            "请减少截图数量、或改用 cds/cli/acceptance 的 JPEG 压图取证管线（chromium-canvas 缩放）后重跑。")

    payload = {
        "title": title, "format": "md", "content": content,
        "projectId": project_id, "folderId": folder_id,
        "verdict": a.verdict, "tier": a.tier,
    }
    if (a.branch or "").strip():
        payload["branch"] = a.branch.strip()
    if (a.commit or "").strip():
        payload["commitSha"] = a.commit.strip()
    pr = getattr(a, "pr", None)
    if pr:
        payload["prNumber"] = pr
    resp = _cds_call("POST", "/api/reports", payload)
    rep = resp.get("report") if isinstance(resp, dict) else None
    if not rep or not rep.get("id"):
        raise RuntimeError(f"CDS 入库失败：{json.dumps(resp, ensure_ascii=False)[:300]}")
    rid = rep["id"]
    base = _cds_base()
    # 深链必须用 CDS 返回的**规范 id**：config 给的可能是项目 slug(如 prd-agent)，POST 时 CDS
    # 会把 slug 规范成真实 projectId，但 Reports 页按存储的 projectId 过滤；深链若写回 slug，
    # 列表端点 /api/reports?projectId=<slug> 命中空集，点开是空白(Codex review P2)。folderId
    # 同理用返回值兜准。
    link_project = rep.get("projectId") or project_id
    link_folder = rep.get("folderId") or folder_id
    qs = []
    if link_project:
        qs.append(f"project={link_project}")
    if link_folder:
        qs.append(f"folder={link_folder}")
    qs.append(f"report={rid}")
    deeplink = f"{base}/reports?" + "&".join(qs)
    print(json.dumps({
        "mode": "cds", "title": title, "report_id": report_id, "cdsReportId": rid,
        "projectId": project_id, "folderId": folder_id, "verdict": a.verdict, "deeplink": deeplink,
    }, ensure_ascii=False))
    print("\n===== 验收归档完成 · CDS 验收中心 =====")
    print("直达深链（CDS 登录态可达，按项目+文件夹归类）：" + deeplink)
    print("说明：报告已入 CDS（验收能力的唯一归属）；MAP 等系统通过知识库开放协议从 CDS 拉取展示，无需另建验收知识库。")


def run_local(cfg, a, title, report_id, body, manifest, meta, tags=None):
    out_dir = cfg["report"].get("localOutDir") or LOCAL_DEFAULT_OUT_DIR
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
    # 正式环境临时兜底可设 MAP_DOC_STORE_JWT=ey...（登录态 Bearer）。
    # 未设时回退 AI 超级密钥 + X-AI-Impersonate（向后兼容）。
    agent_key_env = api.get("agentKeyEnv", "MAP_DOC_STORE_KEY")
    agent_key = os.environ.get(agent_key_env, "").strip()
    jwt_env = api.get("jwtEnv", "MAP_DOC_STORE_JWT")
    jwt = os.environ.get(jwt_env, "").strip()
    if agent_key:
        H = ["-H", f"Authorization: Bearer {agent_key}"]
        imp = os.environ.get(api.get("impersonateEnv", ""), "") or "(scoped-key-owner)"
        print(f"  鉴权：AgentApiKey scope（{agent_key_env}，最小权限 document-store:write）")
    elif jwt:
        H = ["-H", f"Authorization: Bearer {jwt}"]
        imp = os.environ.get(api.get("impersonateEnv", ""), "") or "(jwt-user)"
        print(f"  鉴权：登录态 Bearer（{jwt_env}，正式环境临时兜底）")
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
    stores = data_or_raise(curl(H + [f"{base}/stores?pageSize=100"]), "列出知识库")["items"]
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
        rid = data_or_raise(curl(HJ + ["-X", "POST", "-d", json.dumps(
            {"name": store_name, "description": cfg["report"].get("storeDescription", ""),
             "isPublic": want_public,
             # 模板键：让"验收报告库"对写入条目做结构约束（design.acceptance.kb.md §5.B）。
             # 机器归档缺必填 metadata/正文 section 会被后端 422 拒收。
             "templateKey": want_template}
        ), f"{base}/stores"]), "创建知识库")["id"]
    print(f"  报告库 id={rid}")

    # 一次性知识库传输协议：
    # - 正文仍用 {{IMG:name}} 或 {{EVIDENCE}} 表达结构。
    # - 截图 bytes 随 PUT /content 的 assets[] 一次提交。
    # - 后端负责上传正式资产、重写 Markdown 图片 URL、写 ParsedPrd 与刷新 document 缓存。
    # 这样技能不再猜图片域名，也不会留下 data:image 破图或“上传临时图条目再删除”的中间状态。
    evidence = "\n\n".join(f"**{m['caption']}**\n\n{{{{IMG:{m['name']}}}}}" for m in manifest)
    assets = []
    for m in manifest:
        with open(m["path"], "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        assets.append({
            "name": m["name"],
            "caption": m["caption"],
            "mime": "image/png",
            "base64": data,
            "fileName": f"{m['name']}.png",
            "extensionHint": "png",
        })
        print(f"  准备一次性图片资产 {m['name']} ({os.path.getsize(m['path'])}B)")

    meta = build_meta(report_id, now, imp, a, preview)
    content = assemble(title, body, evidence, meta)

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
    eid = data_or_raise(curl(HJ + ["-X", "POST", "-d", json.dumps({
        "title": title, "summary": f"# {title}",  # 双保险:summary 也以标题打头
        "sourceType": "reference", "contentType": "text/markdown",
        "tags": tags or [],  # 状态(通过/不通过)+操作方式+档位走标签，不进标题
        "metadata": entry_meta,
    }), f"{base}/stores/{rid}/entries"]), "创建知识库条目")["id"]
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
        w = curl_json(H, "PUT", f"{base}/entries/{eid}/content", {
            "content": content,
            "assets": assets,
            "assetDomain": cfg["report"].get("assetDomain"),
        })
        print(f"  写正文 success={w.get('success')}")
        ok = _has_content()
        if not ok:  # 返回了但没落库 → 再写一次
            curl_json(H, "PUT", f"{base}/entries/{eid}/content", {
                "content": content,
                "assets": assets,
                "assetDomain": cfg["report"].get("assetDomain"),
            })
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
        tok = data_or_raise(curl(HJ + ["-X", "POST", "-d", json.dumps({"title": title, "expiresInDays": 0}),
                         f"{base}/stores/{rid}/share-links"]), "创建分享链接")["token"]
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
DEEP_DAILY_MIN_SHOTS = 12
JUNK_TARGETS = {"test", "测试", "xxx", "demo", "tmp", "临时", "aaa", "todo"}
PLACEHOLDER_PAT = re.compile(r"\{YYYY|\{target\}|\{project\}|\{verdict|\{date\}|\{commit\}|\{branch\}|\{sha\}|\{url\}|\{\{(?!EVIDENCE\}\}|IMG:)")
THIN_CELL_PAT = re.compile(r"^(同上|见上文|参见上文|略|省略|按常规|常规|待定|TBD|todo)$", re.I)


def _target_declares_daily_scope(target):
    t = (target or "").strip()
    if not t:
        return False
    if re.fullmatch(r"(每日|昨日|昨天)(?:的)?(?:全部|所有)?(?:内容|工作|变更|更新|改动)?(?:验收|复验|测试|报告)?", t):
        return True
    return bool(re.search(
        r"(每日验收|昨日验收|昨天验收|每日复验|昨日复验|昨天复验|每日测试|昨日测试|昨天测试|"
        r"每日报告|昨日报告|昨天报告|验收昨日|验收昨天|"
        r"(昨日|昨天)(?:的)?(?:全部|所有)(?:内容|开发|工作|更新|改动|变更|做完的内容)|"
        r"(昨日|昨天)(?:做完的内容|开发的全部内容|开发的所有内容))",
        t,
    ))


def _scope_declaration_text(target, body):
    """Only scan target and explicit report scope/scenario/depth lines."""
    picked = [(target or "").strip()]
    table_scope_section = False
    scope_label = re.compile(
        r"(目标日期|验收目标|验收范围|验收场景|主场景|修饰场景|scenario|scope|"
        r"提交范围|PR\s*范围|commit\s*(?:range|sha)|验收深度|深度预算|改动规模与深度预算)",
        re.I,
    )
    table_scope_token = re.compile(
        r"(PR\s*#?\s*\d+|[0-9a-f]{7,40}|pull[- ]request|commit[- ]range|"
        r"unpublished[- ]branch|defect[- ]retest|visual[- ]regression|release[- ]preflight)",
        re.I,
    )
    for line in (body or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            table_scope_section = bool(re.search(r"(PR/commit|PR\s*到|commit|提交|改动断言|范围映射)", s, re.I))
            picked.append(s)
            continue
        if scope_label.search(s):
            picked.append(s)
            continue
        if table_scope_section and s.startswith("|") and table_scope_token.search(s):
            picked.append(s)
    return "\n".join(picked)


def _declares_complex_acceptance(target, body):
    """Return true only for explicit complex acceptance scenarios, not generic metadata columns."""
    if _target_declares_daily_scope(target):
        return True
    text = _scope_declaration_text(target, body)
    patterns = [
        r"(每日|昨日|昨天)\s*(?:验收|复验|测试|报告)",
        r"(?:验收|复验|测试|报告).{0,8}(每日|昨日|昨天)",
        r"PR\s*#?\s*\d+",
        r"\b[0-9a-f]{7,40}\b",
        r"pull[- ]request",
        r"(commit|提交)\s*(?:[- ]?range|范围|验收|复验|测试|报告|[=:：# ]*[0-9a-f]{7,40})",
        r"(未发布分支|分支验收|缺陷复测|视觉回归|发布前验收|"
        r"unpublished[- ]branch|defect[- ]retest|visual[- ]regression|release[- ]preflight)",
        r"\bdaily[-_ ]?yesterday\b",
    ]
    return any(re.search(p, text, re.I) for p in patterns)


def _declares_daily_acceptance(target, body):
    if _target_declares_daily_scope(target):
        return True
    text = _scope_declaration_text(target, body)
    return bool(re.search(
        r"(每日|昨日|昨天)\s*(?:验收|复验|测试|报告)|"
        r"(?:验收|复验|测试|报告).{0,8}(每日|昨日|昨天)|"
        r"\bdaily[-_ ]?yesterday\b",
        text,
        re.I,
    ))


def _declares_deep_daily_acceptance(target, body):
    """Daily deep gate applies only to positive deep-acceptance declarations."""
    scope_text = _scope_declaration_text(target, body)
    daily_context = _target_declares_daily_scope(target) or bool(re.search(
        r"(每日|昨日|昨天)\s*(?:验收|复验|测试|报告)|"
        r"(?:验收|复验|测试|报告).{0,8}(每日|昨日|昨天)|"
        r"\bdaily[-_ ]?yesterday\b",
        scope_text,
        re.I,
    )) or bool(re.search(
        r"(每日|昨日|昨天).{0,12}(深度验收|深度复验|深入功能验收)|"
        r"(深度验收|深度复验|深入功能验收).{0,12}(每日|昨日|昨天)",
        target or "",
    ))
    if not daily_context:
        return False
    negated = re.compile(
        r"(不是|非|不属于|未达到|不满足|禁止|不能|不得|只能叫|只能标为|降级为).{0,14}(深度验收|深度复验|深入功能验收)|"
        r"(深度验收|深度复验|深入功能验收).{0,14}(不通过|不适用|不满足|不能|不得)"
    )
    positive = re.compile(
        r"(验收深度|深度|档位)\s*[:：|= ]+\s*(深度验收|深度复验|深入功能验收)|"
        r"(本次|本报告|目标|验收目标).{0,12}(深度验收|深度复验|深入功能验收)|"
        r"(每日|昨日|昨天).{0,12}(深度验收|深度复验|深入功能验收)|"
        r"(深度验收|深度复验|深入功能验收).{0,12}(每日|昨日|昨天)"
    )
    for line in [target or "", *((body or "").splitlines())]:
        s = line.strip()
        if not s or not re.search(r"(深度验收|深度复验|深入功能验收)", s) or negated.search(s):
            continue
        if "验收深度" in s and re.search(r"(深度验收|深度复验|深入功能验收)", s):
            return True
        if s.startswith("|") and re.search(r"\|\s*(深度验收|深度复验|深入功能验收)\s*\|", s):
            return True
        if positive.search(s):
            return True
    return False


def _thin_table_cells(body, section_names):
    """Find table cells that hide missing evidence with vague filler words."""
    hits = []
    active = False
    for line in (body or "").splitlines():
        ls = line.strip()
        if ls.startswith("#"):
            active = any(name in ls for name in section_names)
            continue
        if not active or not ls.startswith("|"):
            continue
        cells = [c.strip().strip("。；;,.，") for c in ls.strip("|").split("|")]
        for cell in cells:
            if THIN_CELL_PAT.fullmatch(cell):
                hits.append(ls[:120])
                break
    return hits


def validate_inputs(a, body, manifest, cfg=None):
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
    daily_acceptance_claim = _declares_daily_acceptance(a.target, body)
    deep_daily_claim = _declares_deep_daily_acceptance(a.target, body)
    complex_acceptance_claim = _declares_complex_acceptance(a.target, body)
    if deep_daily_claim and len(manifest) < DEEP_DAILY_MIN_SHOTS:
        errs.append(
            f"[深度门禁] 每日/昨日报告声称深度验收，但截图数 {len(manifest)} < "
            f"{DEEP_DAILY_MIN_SHOTS}。少量入口图只能标为「广度冒烟」，不得冒充深度验收"
        )
    errs.extend(artifact_path_errors(manifest, cfg))
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
    if complex_acceptance_claim:
        if "改动断言到证据表" not in body:
            errs.append("[结构] 复杂验收缺「改动断言到证据表」标题：必须把 PR/commit 的改动断言连到真实操作/API/状态证据，不能用同模块邻近页面顶替")
        for kw in ("改动断言", "必要证明", "实际证据", "关联性"):
            if kw not in body:
                errs.append(f"[结构] 复杂验收缺「{kw}」字段：无法判断提交信息与截图/接口证据是否相关")
        if "页面优先证据分层" not in body:
            errs.append("[结构] 复杂验收缺「页面优先证据分层」标题：用户可感知改动必须先说明页面反馈，再用 API/日志/状态作内部佐证")
        for kw in ("用户可见页面", "页面证据", "内部佐证"):
            if kw not in body:
                errs.append(f"[结构] 复杂验收缺「{kw}」字段：无法判断报告是否把页面反馈放在内部数据之前")
        for section in ("改动断言表", "影响面矩阵", "融合测试设计", "证明力矩阵", "覆盖缺口"):
            if section not in body:
                errs.append(f"[结构] 复杂验收缺「{section}」：必须先完成验收测试设计，再进入视觉截图和归档")
    if daily_acceptance_claim:
        for section in (
            "昨日工作总结",
            "改动规模与深度预算",
            "标记法则与验收标准",
            "PR/commit 到结果映射",
            "覆盖矩阵",
            "截图回读检查",
            "重试记录",
            "未发布状态",
        ):
            if section not in body:
                errs.append(f"[结构] 每日/昨日报告缺「{section}」：每日自动验收必须能说明范围、标准、未发布状态、截图回读和重试事实")
        if not re.search(r"(计划证据数|计划截图数|planned evidence|planned screenshots)", body, re.I):
            errs.append("[结构] 每日/昨日报告缺计划证据数：无法判断深度预算是否覆盖变更规模")
        if not re.search(r"(实际证据数|实际截图数|actual evidence|actual screenshots)", body, re.I):
            errs.append("[结构] 每日/昨日报告缺实际证据数：无法判断报告是否按预算执行")
        if deep_daily_claim and not re.search(r"(负面|边界|失败路径|negative|boundary)", body, re.I):
            errs.append("[深度门禁] 深度每日验收缺负面/边界路径说明：不能只用 happy path 声称深度通过")
        thin_hits = _thin_table_cells(body, (
            "PR/commit 到结果映射",
            "改动断言到证据表",
            "改动断言表",
            "页面优先证据分层",
            "覆盖矩阵",
            "覆盖缺口",
            "缺陷清单",
            "截图回读检查",
        ))
        if thin_hits:
            errs.append("[内容充裕] 每日/昨日报告关键表格含空泛占位单元（同上/见上文/略/按常规/TBD 等），会遮盖遗漏。示例：" + " | ".join(thin_hits[:3]))
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

    # ── v2.4 诉求连线（2026-06-10 第二波：用户在证据板上发现「诉求 3 由 0 张证据证明（无连线）」）──
    # 「需求一一对应表」里状态为已落地/已实现/完成/pass 的行，最后一列必须连到证据：
    # 引用「图XX」（manifest 有对应图）或「用例N」（用例行自身已被 v2.3 强制连图）。
    # 没连线的"已落地"诉求 = 无证声称，整份报告拒收。
    in_req_table = False
    for line in body.splitlines():
        ls = line.strip()
        if ls.startswith("#"):
            in_req_table = "需求一一对应" in ls
            continue
        if not in_req_table or not ls.startswith("|"):
            continue
        cells = [c.strip() for c in ls.strip("|").split("|")]
        if len(cells) < 3:
            continue
        if not any(re.fullmatch(r"(已落地|已实现|已完成|完成|pass|done)", c, re.I) for c in cells):
            continue  # 表头/分隔行/未落地行不查（未做的诉求本来就没有图）
        tail = cells[-1]
        img_refs = re.findall(r"图\s*([0-9]+[a-zA-Z]?)", tail)
        case_refs = re.findall(r"用例\s*[0-9]+", tail)
        if not img_refs and not case_refs:
            errs.append(f"[断链] 已落地诉求 0 证据连线（需引用「图XX」或「用例N」）：{ls[:70]}")
            continue
        for r0 in img_refs:
            if not any(n.lower().startswith(r0.lower()) for n in mani_names):
                errs.append(f"[断链] 诉求引用「图{r0}」但 manifest 无以 {r0} 开头的截图：{ls[:70]}")

    # ── v2.5 验收地址 + 步骤式证据（2026-06-11 用户指出：报告无标的物地址无法跳转；
    #    集中 {{EVIDENCE}} 在证据板渲染成「没有可解析的证据步骤」）──
    if "验收地址" not in body or "http" not in body:
        errs.append("[结构] 报告缺「验收地址」段（被验收功能页的可点击深链 + 分支/commit）——读者必须能从报告一键跳到标的物")
    # 步骤式证据门禁按档位缩放：与 TIER_MIN_SHOTS 一致，L0 轻量验收不应被
    #「>=3 步骤」硬卡（Bugbot：L0 只要 1 图却被 3 步骤门拒）。下限 = min(档位截图下限, 3)。
    step_floor = min(TIER_MIN_SHOTS.get(a.tier, 3), 3)
    step_heads = re.findall(r"^## 步骤\s*\d+", body, re.M)
    img_count = len(re.findall(r"\{\{IMG:", body))
    if len(step_heads) < step_floor or img_count < step_floor:
        errs.append(f"[结构] 证据必须步骤式：{a.tier} 档需 >={step_floor} 个「## 步骤 N」段且逐段 {{{{IMG:}}}} 配图（当前步骤={len(step_heads)} 配图={img_count}）。"
                    "证据板按步骤解析，集中 {{EVIDENCE}} 会渲染成『没有可解析的证据步骤』")
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
    ap.add_argument("--pr", type=int, default=None, help="关联 PR 编号（E1 部署上下文，便于 E4 回写）")
    ap.add_argument("--force", action="store_true", help="越过准入校验（仅在确知合理时用，会打印告警）")
    a = ap.parse_args()

    cfg = json.load(open(a.config))
    # 职责分离（2026-06-25）：验收报告默认归 CDS 验收中心，技能不再分流到 MAP 知识库。
    # local 仍作离线兜底；旧 doc-store 仅在 config 显式保留时走（向后兼容，不推荐）。
    mode = cfg.get("report", {}).get("mode", "cds")
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
    errs = validate_inputs(a, body, manifest, cfg)
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
        elif mode == "doc-store":
            # 向后兼容：仅当 config 显式 mode=doc-store 才走旧 MAP 知识库路径。
            run_doc_store(cfg, a, title, report_id, body, manifest, now, preview, tags)
        else:
            # 默认主路：CDS 验收中心。
            run_cds(cfg, a, title, report_id, body, manifest, now, tags)
    except Exception as e:
        import sys as _sys
        print("\n[归档失败] 写库未完成（常见原因：预览环境 524 / 容器重启 / API 不可达）。")
        print("  原因：" + str(e)[:200])
        print("  报告正文与截图已就绪；待预览环境稳定后用同样命令重跑即可（生成新 report_id）。")
        _sys.exit(3)


if __name__ == "__main__":
    main()
