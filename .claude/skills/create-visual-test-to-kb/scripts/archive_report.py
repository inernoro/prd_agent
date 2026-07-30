#!/usr/bin/env python3
"""验收 · 报告归档（项目无关，配置驱动）。

职责分离（2026-06-25）：验收能力归 CDS 验收中心，技能不再分流到 MAP 知识库。
报告永远按项目入库 CDS；MAP 等系统通过知识库开放协议（peer-sync）从 CDS 拉取展示。

三种输出模式（由 acceptance.config.json 的 report.mode 决定，缺省 = cds）：
  - cds（默认主路）：截图先进入 CDS 内容寻址资产库，Markdown 写作源引用不可变图片地址
    → 交互 HTML → POST /api/reports，
    按项目 + 文件夹归类，带 verdict / tier / 部署上下文元数据 → 出 /reports 直达深链。
    依赖 env：CDS_HOST + (CDS_PROJECT_KEY 或 AI_ACCESS_KEY)。
  - local：把报告写成本地 html/md + 截图拷到本地目录，图用相对路径引用。**零依赖**，
    适合没有 CDS / 离线兜底。
  - doc-store（向后兼容，不推荐）：旧 MAP 知识库路径，仅当 config 显式保留 mode=doc-store 才走。

用法：
  python3 archive_report.py \
    --config <acceptance.config.json> \
    --target "知识库订阅保存双通道" \
    --report-kind "功能验收" \
    --title-focus "知识库订阅保存" \
    --report-date "2026-07-23" \
    --verdict pass --tier L2 \
    --report-md <报告正文.md，速览卡+九段，正文里用 {{EVIDENCE}} 占位> \
    --manifest <harness 产出的 manifest.json：[{name,caption,path}]> \
    [--branch xxx --commit xxx --pr 922]
"""
import argparse, json, os, subprocess, datetime, re, shutil, time, base64, tempfile, html, hashlib
from html.parser import HTMLParser
from pathlib import Path

LOCAL_DEFAULT_OUT_DIR = "/tmp/map-acceptance-local"
REPORT_KINDS = (
    "功能验收",
    "每日验收",
    "PR验收",
    "Commit验收",
    "分支验收",
    "缺陷复测",
    "视觉回归",
    "发布验收",
    "规范演练",
)

DAILY_REQUIRED_SECTIONS = (
    "结论分层",
    "昨日工作总结",
    "改动规模与深度预算",
    "标记法则与验收标准",
    "PR/commit 到结果映射",
    "覆盖矩阵",
    "截图回读检查",
    "重试记录",
    "未发布状态",
)

DAILY_CONCLUSION_FIELDS = (
    "产品质量",
    "验收完整性",
    "综合结论",
    "发布建议",
    "判定性质",
)
DAILY_ROOT_CAUSE_FIELDS = (
    "目标要求",
    "观察事实",
    "系统原因",
    "证据影响",
    "结论",
    "关闭动作",
)
VERDICT_NATURES = {
    "pass": {"完整通过"},
    "conditional": {"覆盖不足", "非阻断风险"},
    "fail": {"产品失败", "核心用例失败", "验收链路失败", "硬门禁失败"},
}


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
    generated_at = now.isoformat(timespec="seconds")
    report_version = (getattr(a, "report_version", "") or "v0.9").strip()
    return (
        "\n\n<!-- acceptance-meta\n"
        "type: acceptance-report\nstandard: MAP-Acceptance-v2\n"
        f"report_id: {report_id}\ndate: {generated_at}\n"
        f"reviewer: {reviewer}\nverdict: {a.verdict}\ntier: {a.tier}\n"
        f"report_kind: {getattr(a, 'report_kind', '')}\n"
        f"report_date: {getattr(a, 'report_date', '')}\n"
        f"report_version: {report_version}\n"
        f"target_ref: {a.target}\npreview_url: {preview}\n"
        f"branch: {a.branch}\ncommit: {a.commit}\n-->\n"
    )


def ensure_report_time(body, generated_at):
    """Every acceptance report must render the current system time.

    Authors may still provide their own time block. If they do not, inject a
    visible section before Verdict so CDS/HTML/doc-store outputs are all covered.
    """
    text = body or ""
    if re.search(r"^##\s*(验收时间|报告时间|生成时间)\s*$", text, re.M):
        return text
    if re.search(r"\|\s*(验收时间|报告时间|生成时间)\s*\|", text):
        return text
    return f"## 验收时间\n\n{generated_at}\n\n" + text


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


def _figure_key(name):
    raw = (name or "").strip().lower()
    if not re.match(r"^[0-9]{1,3}[a-z]?", raw, re.I):
        return ""
    return re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")


def _figure_number(name):
    m = re.match(r"^([0-9]{1,3}[A-Za-z]?)", (name or "").strip())
    return m.group(1).lower() if m else ""


def _figure_anchor(key):
    safe = re.sub(r"[^a-z0-9-]+", "-", (key or "").lower()).strip("-")
    return f"fig-{safe}" if safe else ""


def _with_figure_anchor(name, md):
    key = _figure_key(name)
    anchor = _figure_anchor(key)
    return f'<span id="{anchor}" class="figure-anchor"></span>\n\n{md}' if anchor else md


def link_figure_refs(content, manifest_names):
    """把正文里的裸「图01」引用补成站内锚点链接。

    报告作者仍应主动写 `[图01](#fig-01-login-home)` 这类完整锚点；这里是兜底，避免每日验收长表格
    只能看不能点。只链接 manifest 里真实存在且编号唯一的截图，重复编号保留纯文本，
    避免把双主题/多变体截图错连到第一张。
    """
    anchors_by_num = {}
    for name in manifest_names:
        num = _figure_number(name)
        anchor = _figure_anchor(_figure_key(name))
        if num and anchor:
            anchors_by_num.setdefault(num, []).append(anchor)
    anchors_by_num = {
        num: anchors[0]
        for num, anchors in anchors_by_num.items()
        if len(set(anchors)) == 1
    }
    if not anchors_by_num:
        return content

    def link_repl(m):
        anchor = anchors_by_num.get(m.group(1).lower())
        return "](#" + anchor + ")" if anchor else m.group(0)

    content = re.sub(r"\]\(#fig-([0-9]{1,3}[A-Za-z]?)\)", link_repl, content)

    def range_repl(m):
        start_raw, end_raw = m.group(1), m.group(2)
        start, end = int(start_raw), int(end_raw)
        if end < start or end - start > 99:
            return m.group(0)
        width = max(len(start_raw), len(end_raw))
        links = []
        for value in range(start, end + 1):
            num = str(value).zfill(width)
            anchor = anchors_by_num.get(num.lower())
            if not anchor:
                return m.group(0)
            links.append(f"[图{num}](#{anchor})")
        return "、".join(links)

    # 范围引用不能只把首图变成链接，否则「图02-05」会伪装成一个可点击范围，
    # 实际只指向图02。先确定性展开，再处理单个裸图号。
    content = re.sub(
        r"(?<!\[)图\s*([0-9]{1,3})\s*[-–—~至到]\s*([0-9]{1,3})",
        range_repl,
        content,
    )

    def repl(m):
        key = m.group(1).lower()
        anchor = anchors_by_num.get(key)
        if not anchor:
            return m.group(0)
        return f"[图{m.group(1)}](#{anchor})"

    # 负向前瞻/回顾避免把已经写成 [图01](...) 的链接再包一层。
    return re.sub(r"(?<!\[)图\s*([0-9]{1,3}[A-Za-z]?)(?!\]\()", repl, content)


def assemble(title, body, evidence, meta, img_md=None, manifest_names=None):
    """正文以 H1 标题打头（根治目录 `---`，见标准 §2.1），机读字段在文末注释。
    支持两种图片占位：
      - {{IMG:<截图name>}} —— ZZ 照做风：把该步截图内联到此处（文字在上图在下，逐步配图）
      - {{EVIDENCE}}       —— 旧版：把所有截图集中堆到此处（§9 证据段）
    """
    names = list(manifest_names or (img_md or {}).keys())
    referenced_names = {
        name.strip()
        for name in re.findall(r"\{\{IMG:([^}]+)\}\}", body or "")
    }
    uses_evidence_board = "{{EVIDENCE}}" in (body or "")
    content = link_figure_refs(body, names)
    if img_md:
        for name, md in img_md.items():
            content = content.replace(
                "{{IMG:%s}}" % name,
                "\n\n" + _with_figure_anchor(name, md) + "\n\n",
            )
    else:
        for name in names:
            ph = "{{IMG:%s}}" % name
            content = content.replace(ph, "\n\n" + _with_figure_anchor(name, ph) + "\n\n")
    evidence_board = evidence
    if uses_evidence_board and img_md:
        # 同时使用逐步插图和证据板时，证据板只补剩余截图，避免同一个 fig id
        # 在正文出现两次。纯证据板模式仍会按 manifest 顺序放入全部截图。
        evidence_board = "\n\n".join(
            _with_figure_anchor(name, img_md[name])
            for name in names
            if name not in referenced_names and name in img_md
        )
    content = content.replace("{{EVIDENCE}}", evidence_board)

    # manifest 是截图事实源。写作者漏放 {{IMG}} 时，由程序补入统一的补充证据段，
    # 不能继续生成「有卡片、无图片、无锚点」的半截关系。语义归属仍由 caption/
    # claim 字段说明；这里只补确定性的图片、图号和锚点，不猜它证明哪条需求。
    if not uses_evidence_board:
        missing = [name for name in names if name not in referenced_names]
        if missing:
            supplemental = []
            for name in missing:
                md = (img_md or {}).get(name) or "{{IMG:%s}}" % name
                supplemental.append(_with_figure_anchor(name, md))
            content = (
                content.rstrip()
                + "\n\n## 补充证据（归档程序自动填充）\n\n"
                + "> 以下截图存在于 manifest，但写作源未单独放置。归档程序仅补齐图片与锚点，不推断需求语义。\n\n"
                + "\n\n".join(supplemental)
                + "\n"
            )
    return f"# {title}\n\n" + content + meta


def report_format(cfg, mode):
    if mode == "doc-store":
        return "md"
    raw = str((cfg.get("report") or {}).get("format") or "html").strip().lower()
    return "md" if raw in {"md", "markdown"} else "html"


def _html_id(text, fallback):
    base = re.sub(r"[^a-z0-9一-鿿]+", "-", (text or "").lower()).strip("-")
    return base[:80] or fallback


GITHUB_COMMIT_BASE = "https://github.com/inernoro/prd_agent/commit/"
METHOD_FOLDER_BASE = "/reports?project=prd-agent&folder=b01a432f519541dbbd387286018e6721&report="
METHOD_DOC_ENTERPRISE = METHOD_FOLDER_BASE + "0efbef7c40fc4d94a8b14e60113524a9"
METHOD_DOC_DAILY = METHOD_FOLDER_BASE + "cf097d19b4b649ad92b15546bf13d996"
METHOD_DOC_SSOT = METHOD_FOLDER_BASE + "3992cb728a9c4a23958b4ec92933f59b"
METHOD_DOC_EVIDENCE = METHOD_FOLDER_BASE + "7bcc189776354b7db1600dcb91c97e17"
METHOD_DOC_GOVERNANCE = METHOD_FOLDER_BASE + "c67d7301c52d41359fc691978d923426"
METHOD_DOCS = [
    ("MAP 企业级自动化验收规范", METHOD_DOC_ENTERPRISE),
    ("MAP 验收规范 SSOT", METHOD_DOC_SSOT),
    ("验收报告与证据交互规范", METHOD_DOC_EVIDENCE),
]
METHOD_SECTION_DOCS = {
    "改动规模与深度预算": (
        "范围预算测试：先量化 commit、模块、高风险和证据预算，避免把大范围日报包装成深度通过。",
        METHOD_DOC_DAILY,
    ),
    "PR/commit 到结果映射": (
        "变更映射测试：把 commit 分组映射到模块和结果，确认没有把变更藏在总述里。",
        METHOD_DOC_ENTERPRISE,
    ),
    "改动断言表": (
        "断言抽取测试：先说明每个 commit 声称改变了什么，再决定需要什么证据。",
        METHOD_DOC_ENTERPRISE,
    ),
    "改动断言到证据表": (
        "证据关联测试：每条断言必须连到页面证据、内部佐证和关联性结论。",
        METHOD_DOC_ENTERPRISE,
    ),
    "影响面矩阵": (
        "影响面测试：沿上游输入、用户路径、下游输出、持久化、权限和异步依赖拆风险。",
        METHOD_DOC_ENTERPRISE,
    ),
    "融合测试设计": (
        "融合测试：把相关改动合并成用户旅程，验证跨模块行为而不是孤立页面。",
        METHOD_DOC_ENTERPRISE,
    ),
    "证明力矩阵": (
        "证明力测试：按页面证据、交互动作、内部佐证和失败条件评估证据强度。",
        METHOD_DOC_ENTERPRISE,
    ),
    "页面优先证据分层": (
        "页面优先测试：用户可感知改动先看页面反馈，API 和日志只作第二证据。",
        METHOD_DOC_EVIDENCE,
    ),
    "覆盖矩阵": (
        "覆盖测试：按模块列出已覆盖证据和缺口，防止把抽样误报成全量通过。",
        METHOD_DOC_ENTERPRISE,
    ),
    "截图回读检查": (
        "截图回读测试：每张图都回读核对是否截歪、加载完成、空白和标记准确。",
        METHOD_DOC_EVIDENCE,
    ),
    "验收规范 SSOT": (
        "规范同步测试：确认仓库文档、技能快照和 CDS Markdown 文档引用同一套规则,避免报告流程和规范描述分叉。",
        METHOD_DOC_SSOT,
    ),
    "知识库治理": (
        "知识治理测试：确认长期规范以可同步文档存在,验收报告只保存证据和结论,避免把临时报告混入代码文档。",
        METHOD_DOC_GOVERNANCE,
    ),
}


def _method_note(text):
    title = re.sub(r"\s+", " ", text or "").strip()
    info = METHOD_SECTION_DOCS.get(title)
    if not info:
        return ""
    desc, url = info
    doc_links = "、".join(
        f'<a href="{html.escape(link, quote=True)}" target="_blank" rel="noopener noreferrer">{html.escape(label)}</a>'
        for label, link in METHOD_DOCS
    )
    return (
        '<div class="method-note">'
        f'<strong>这是什么测试：</strong>{html.escape(desc)} '
        f'<span>基础知识：{doc_links}。</span> '
        f'<a href="{html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">了解这种测试的设计根因</a>'
        '</div>'
    )


def _render_inline(text):
    tokens = []

    def stash(value):
        key = f"@@HTML_TOKEN_{len(tokens)}@@"
        tokens.append((key, value))
        return key

    def image_repl(m):
        alt = html.escape(m.group(1).strip())
        url = html.escape(m.group(2).strip(), quote=True)
        return stash(f'<img src="{url}" alt="{alt}" loading="lazy"/>')

    def link_repl(m):
        label = html.escape(m.group(1).strip())
        url = html.escape(m.group(2).strip(), quote=True)
        target = ' target="_blank" rel="noopener noreferrer"' if re.match(r"https?://", url) else ""
        return stash(f'<a href="{url}"{target}>{label}</a>')

    def code_repl(m):
        value = m.group(1).strip()
        if re.fullmatch(r"https?://[^\s<>)，。；、]+", value):
            escaped = html.escape(value)
            href = html.escape(value, quote=True)
            return stash(f'<a href="{href}" target="_blank" rel="noopener noreferrer"><code>{escaped}</code></a>')
        if re.fullmatch(r"[a-f0-9]{8,40}", value, re.I):
            escaped = html.escape(value)
            href = GITHUB_COMMIT_BASE + html.escape(value, quote=True)
            return stash(f'<a href="{href}" target="_blank" rel="noopener noreferrer"><code>{escaped}</code></a>')
        return stash(f"<code>{html.escape(value)}</code>")

    def strong_repl(m):
        return stash(f"<strong>{html.escape(m.group(1).strip())}</strong>")

    raw = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", image_repl, text)
    raw = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link_repl, raw)
    raw = re.sub(r"`([^`]+)`", code_repl, raw)
    raw = re.sub(r"\*\*([^*]+)\*\*", strong_repl, raw)
    raw = re.sub(
        r"(?<![\"'=])(https?://[^\s<>)，。；、]+)",
        lambda m: stash(
            f'<a href="{html.escape(m.group(1), quote=True)}" target="_blank" rel="noopener noreferrer">'
            f'{html.escape(m.group(1))}</a>'
        ),
        raw,
    )
    raw = re.sub(
        r"(?<![a-f0-9/])\b([a-f0-9]{8,40})\b(?![a-f0-9])",
        lambda m: stash(
            f'<a href="{GITHUB_COMMIT_BASE}{html.escape(m.group(1), quote=True)}" '
            f'target="_blank" rel="noopener noreferrer"><code>{html.escape(m.group(1))}</code></a>'
        ),
        raw,
    )
    out = html.escape(raw)
    for key, value in tokens:
        out = out.replace(key, value)
    return out


def _split_markdown_table_row(row):
    cells = []
    buf = []
    s = row.strip()
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    cells.append("".join(buf).strip())
    if cells and cells[0] == "":
        cells = cells[1:]
    if cells and cells[-1] == "":
        cells = cells[:-1]
    return cells


def _section_table(markdown, heading):
    """Return the header and data rows from the first table under an exact H2."""
    section = re.search(
        rf"^##\s+{re.escape(heading)}\s*$\n(.*?)(?=^##\s+|\Z)",
        markdown or "",
        re.M | re.S,
    )
    if not section:
        return [], []

    table = []
    for line in section.group(1).splitlines():
        stripped = line.strip()
        if stripped.startswith("|"):
            table.append(stripped)
        elif table:
            break
    if len(table) < 2:
        return [], []

    parsed = [_split_markdown_table_row(row) for row in table]
    has_separator = bool(re.match(
        r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$",
        table[1],
    ))
    rows = parsed[2:] if has_separator else parsed[1:]
    return parsed[0], [row for row in rows if any(cell.strip() for cell in row)]


def _section_table_rows(markdown, heading):
    """Return data rows from the first Markdown table under an exact H2."""
    _, rows = _section_table(markdown, heading)
    return rows


def _section_text(markdown, heading):
    """Return the Markdown body of the first exact H2 section."""
    section = re.search(
        rf"^##\s+{re.escape(heading)}\s*$\n(.*?)(?=^##\s+|\Z)",
        markdown or "",
        re.M | re.S,
    )
    return section.group(1) if section else ""


ZERO_COVERAGE_GAP_PAT = re.compile(
    r"(?:(?:0|零)\s*(?:项|个)?\s*(?:无法确认|未覆盖|覆盖缺口|缺口)"
    r"|(?:无法确认|未覆盖|覆盖缺口|缺口)\s*(?:为|[:：=])?\s*(?:0|零)\s*(?:项|个)?"
    r"|(?:无|没有)\s*(?:任何)?\s*(?:无法确认|未覆盖|覆盖缺口|缺口))",
    re.I,
)


def _strip_zero_coverage_gap_phrases(text):
    """Remove explicit zero/negated gap claims before positive gap detection."""
    return ZERO_COVERAGE_GAP_PAT.sub(" ", text or "")


def _severity_counts_from_text(text):
    """Parse P0-P3 counts without losing non-zero values later in a vector."""
    raw = text or ""
    labels = r"P0\s*/\s*P1\s*/\s*P2\s*/\s*P3"
    vector = re.search(
        labels
        + r"\s*[:：=]\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)",
        raw,
        re.I,
    )
    if vector:
        return {f"P{index}": int(value) for index, value in enumerate(vector.groups())}

    uniform = re.search(labels + r"\s*均?为\s*(\d+)", raw, re.I)
    if uniform:
        value = int(uniform.group(1))
        return {f"P{index}": value for index in range(4)}

    individual = {
        severity.upper(): int(value)
        for severity, value in re.findall(r"\b(P[0-3])\s*[:：=]\s*(\d+)\b", raw, re.I)
    }
    return individual or None


def _strip_severity_count_claims(text):
    """Remove parsed P0-P3 count declarations before free-text severity checks."""
    raw = text or ""
    labels = r"P0\s*/\s*P1\s*/\s*P2\s*/\s*P3"
    raw = re.sub(
        labels
        + r"\s*[:：=]\s*\d+\s*/\s*\d+\s*/\s*\d+\s*/\s*\d+",
        " ",
        raw,
        flags=re.I,
    )
    raw = re.sub(labels + r"\s*均?为\s*\d+", " ", raw, flags=re.I)
    return re.sub(r"\bP[0-3]\s*[:：=]\s*\d+\b", " ", raw, flags=re.I)


_FAILURE_ACTION_PATTERN = (
    r"(?:通过|完成|成功|送达|归档|发布|打开|访问|连接|恢复|解决|"
    r"关闭|修复|正常|可用|就绪|部署|上线|生效|合并|ready)"
)
_DELIVERY_ACTION_PATTERN = r"(?:部署|发布|上线|生效|合并)"
_CLOSURE_OBJECT_PATTERN = (
    r"(?:代码|补丁|配置|脚本|实现|逻辑|版本|提交|分支|镜像|依赖|文档|"
    r"模板|数据|记录|材料|工单|缺陷)"
)
_PENDING_DELIVERY_PATTERN = (
    rf"(?:(?:(?:仍|尚|还|暂时?)?未|没(?:有)?)\s*{_DELIVERY_ACTION_PATTERN}"
    rf"|(?:等待|待)\s*{_DELIVERY_ACTION_PATTERN})"
)
_ONGOING_FAILURE_PREFIX_PATTERN = (
    r"(?:(?:尚|还|仍然?|依然|暂时?|至今)?(?:未|没(?:有)?))"
)
_FAILURE_QUANTIFIER_PATTERN = r"(?:(?:全部|完全|全量|全数|全都|悉数)\s*)?"
_FAILURE_FACT_PATTERN = re.compile(
    rf"{_ONGOING_FAILURE_PREFIX_PATTERN}"
    rf"\s*(?:正常\s*)?{_FAILURE_QUANTIFIER_PATTERN}{_FAILURE_ACTION_PATTERN}"
    r"|失败|不通过|未通过|没通过|未成功|没成功|未完成|没完成"
    rf"|未能\s*(?:正常\s*)?{_FAILURE_QUANTIFIER_PATTERN}{_FAILURE_ACTION_PATTERN}"
    r"|阻断|不可用|不可交付"
    r"|超时|报错|中断|漏发|错误|异常|崩溃|卡死|无响应|不可达|断连|断开"
    r"|(?:未能|无法)\s*执行"
    r"|返回\s*[45]\d{2}|状态码\s*[45]\d{2}|HTTP\s*[45]\d{2}"
    rf"|{_PENDING_DELIVERY_PATTERN}"
    rf"|无法\s*(?:正常\s*)?{_FAILURE_QUANTIFIER_PATTERN}{_FAILURE_ACTION_PATTERN}",
    re.I,
)
_DIAGNOSTIC_ACTION_PATTERN = (
    r"(?:复现|重现|再现|定位|捕获|观察到|检测到|发现|触发|确认|验证|记录)"
)
_SUCCESS_DIAGNOSTIC_PATTERN = (
    rf"成功\s*(?:地\s*)?{_DIAGNOSTIC_ACTION_PATTERN}"
)
_DIAGNOSTIC_MODIFIER_PATTERN = (
    rf"(?:已|已经)?{_SUCCESS_DIAGNOSTIC_PATTERN}(?:到了|到|出|了)?"
)
_RESOLVED_STATUS_PREFIX_PATTERN = (
    r"(?:(?:现已|已经|已)|(?:重试后|随后)\s*已|最终(?:已)?)"
)
_RESOLVED_FACT_PATTERN = re.compile(
    rf"{_RESOLVED_STATUS_PREFIX_PATTERN}\s*"
    rf"(?:通过|修复|恢复|可用|关闭|解决|正常|就绪|ready"
    rf"|成功(?!\s*(?:地\s*)?{_DIAGNOSTIC_ACTION_PATTERN}))",
    re.I,
)
_FAILURE_SUBJECT_PATTERNS = (
    (
        "core-case",
        re.compile(r"(?:核心用例|核心流程)(?:执行|测试|验证|检查)?", re.I),
    ),
    ("ready", re.compile(r"ready(?:\s*(?:检查|门禁|状态))?", re.I)),
    ("smoke", re.compile(r"(?:smoke|冒烟)(?:\s*(?:测试|检查|门禁))?", re.I)),
    ("build", re.compile(r"(?:构建|编译)(?:产物|结果)?", re.I)),
    (
        "service-ready",
        re.compile(
            rf"(?:CDS\s*)?服务\s*"
            rf"(?:(?:{_ONGOING_FAILURE_PREFIX_PATTERN}"
            rf"|{_RESOLVED_STATUS_PREFIX_PATTERN})\s*)?"
            r"就绪(?:检查|门禁)?",
            re.I,
        ),
    ),
    ("forced-test", re.compile(r"强制测试", re.I)),
    ("acceptance-chain", re.compile(r"验收链路", re.I)),
    ("evidence-chain", re.compile(r"证据链", re.I)),
    ("archive", re.compile(r"(?:验收报告)?归档(?:流程|任务|操作)?", re.I)),
    (
        "report-publish",
        re.compile(
            rf"(?:验收)?报告\s*(?:{_ONGOING_FAILURE_PREFIX_PATTERN}\s*)?"
            r"发布(?:流程|任务|操作)?",
            re.I,
        ),
    ),
    ("verify-open", re.compile(r"verify-open|打开验证(?:步骤|操作)?", re.I)),
    ("slack", re.compile(r"Slack\s*通知(?:发送)?", re.I)),
)
_ROOT_CAUSE_INSTANCE_PATTERN = re.compile(
    r"移动端|后端|前端|桌面端|管理端|客户端|服务端|网页端"
    r"|iOS|Android|Windows|macOS|Linux|Chrome|Safari|Firefox|Edge"
    r"|生产(?:环境)?|预览(?:环境)?|测试(?:环境)?|灰度(?:环境)?"
    r"|开发(?:环境)?|本地(?:环境)?|主站|控制台|API(?:服务)?|Web(?:端)?"
    r"|prd-(?:api|admin|desktop|video)|llmgw(?:-[A-Za-z0-9_-]+)?",
    re.I,
)
_VERIFIED_SCENARIO_OBJECT_PATTERN = (
    r"(?:场景|用例|测试|重试|处理|请求|响应|路径|分支|案例|样本|输入|"
    r"数据|状态码|逻辑|机制|流程)"
)


def _split_fact_clauses(text):
    """Split facts at punctuation without allowing matches to cross subjects."""
    return re.split(r"([。；;，,|\n])", text or "")


def _failure_subjects(text):
    """Return canonical failure subjects mentioned in a fact fragment."""
    return {
        name
        for name, pattern in _FAILURE_SUBJECT_PATTERNS
        if pattern.search(text or "")
    }


def _subject_occurrences(text, instance_aware=False):
    """Return canonical subject positions for nearest-event binding."""
    occurrences = []
    for name, pattern in _FAILURE_SUBJECT_PATTERNS:
        for match in pattern.finditer(text or ""):
            occurrences.append((match.start(), match.end(), name))
    occurrences.sort()
    if not instance_aware:
        return occurrences

    scoped_occurrences = []
    previous_end = 0
    raw_text = text or ""
    for index, (start, end, name) in enumerate(occurrences):
        prefix = (text or "")[previous_end:start]
        next_subject_start = (
            occurrences[index + 1][0]
            if index + 1 < len(occurrences)
            else len(raw_text)
        )
        suffix = raw_text[end:next_subject_start]
        suffix_events = [
            match
            for pattern in (_FAILURE_FACT_PATTERN, _RESOLVED_FACT_PATTERN)
            for match in pattern.finditer(suffix)
        ]
        qualifier = suffix[
            : min((match.start() for match in suffix_events), default=len(suffix))
        ]
        qualifier = re.split(
            r"(?:以及|并且|和|与|及|、|/|并|且)", qualifier, maxsplit=1
        )[0]
        raw_identities = [
            match.group(0).lower()
            for match in _ROOT_CAUSE_INSTANCE_PATTERN.finditer(
                f"{prefix} {qualifier}"
            )
        ]
        identities = tuple(dict.fromkeys(raw_identities))
        scoped_occurrences.append(
            (start, end, (name, identities or ("__unspecified__",)))
        )
        previous_end = end
    return scoped_occurrences


def _event_anchor_occurrences(event, occurrences, clause, previous_event_end):
    """Bind a status to the preceding subject, except for prefix-status wording."""
    if not occurrences:
        return set()
    overlapping = {
        occurrence
        for occurrence in occurrences
        if occurrence[0] < event.end() and occurrence[1] > event.start()
    }
    if overlapping:
        return overlapping
    left = [occurrence for occurrence in occurrences if occurrence[1] <= event.start()]
    right = [occurrence for occurrence in occurrences if occurrence[0] >= event.end()]
    if right:
        first_right_start = min(start for start, _, _ in right)
        right_gap = clause[event.end() : first_right_start]
        prefix_status = bool(
            re.fullmatch(
                r"\s*的\s*(?:CDS\s*)?(?:验收报告\s*)?",
                right_gap,
                re.I,
            )
        )
        if not left or prefix_status:
            return {
                occurrence
                for occurrence in right
                if occurrence[0] == first_right_start
            }
    last_left_end = max(end for _, end, _ in left)
    left_gap = clause[last_left_end : event.start()]
    left_gap = _ROOT_CAUSE_INSTANCE_PATTERN.sub(" ", left_gap)
    left_gap = re.sub(r"[()（）\[\]【】]", " ", left_gap)
    if previous_event_end > last_left_end or not re.fullmatch(
        rf"\s*(?:(?:当前|目前|现在|本次|先前|此前|一度|曾|仍然|仍|依然|"
        rf"再次|重新|均|都|同时|全部|一并|共同|二者|两者|已|已经|执行|"
        rf"运行|任务|操作|流程|作业|步骤|环节|过程|用例|测试|检查|验证|"
        rf"检测|校验|判定|被判定|显示|表明|呈现|处于|问题|故障|异常|"
        rf"缺陷|结果|状态|为|是|"
        rf"[:：=]|[-=]>|→|{_DIAGNOSTIC_MODIFIER_PATTERN})\s*)*",
        left_gap,
        re.I,
    ):
        return set()
    return {
        occurrence
        for occurrence in left
        if occurrence[1] == last_left_end
    }


def _coordinated_subject_groups(occurrences, clause):
    """Group only adjacent subjects joined by an explicit coordination marker."""
    ordered = sorted(occurrences)
    groups = []
    for occurrence in ordered:
        if not groups:
            groups.append([occurrence])
            continue
        previous = groups[-1][-1]
        gap = clause[previous[1] : occurrence[0]]
        normalized_gap = _ROOT_CAUSE_INSTANCE_PATTERN.sub(" ", gap)
        normalized_gap = re.sub(r"[()（）\[\]【】]", " ", normalized_gap)
        if re.fullmatch(
            r"\s*(?:以及|并且|和|与|及|、|/|并|且)"
            r"\s*(?:CDS\s*)?(?:验收报告\s*)?",
            normalized_gap,
            re.I,
        ):
            groups[-1].append(occurrence)
        else:
            groups.append([occurrence])
    return groups


def _event_subjects(event, occurrences, clause, previous_event_end):
    """Apply a status only to its nearest explicitly coordinated subject group."""
    anchor_occurrences = _event_anchor_occurrences(
        event, occurrences, clause, previous_event_end
    )
    if not anchor_occurrences:
        return set()
    groups = _coordinated_subject_groups(occurrences, clause)
    subjects = set()
    for group in groups:
        if any(occurrence in anchor_occurrences for occurrence in group):
            subjects.update(name for _, _, name in group)
    return subjects


def _apply_subject_state(states, subjects, state):
    """Apply an ordered status event to its explicit or carried subjects."""
    for subject in subjects:
        states[subject] = state


def _closure_changes_subject(clause, event, previous_event_end):
    """Reject negated closures and closures retargeted to an unnamed dependency."""
    scope = clause[previous_event_end : event.start()]
    suffix = clause[event.end() : event.end() + 32]
    if re.search(r"并非|并不是|不是|未曾|尚未|没有", scope, re.I):
        return True
    if re.search(r"并非事实|不是事实|不属实|为假", suffix, re.I):
        return True
    if re.match(rf"\s*(?:的\s*)?{_CLOSURE_OBJECT_PATTERN}", suffix, re.I):
        return True
    if re.search(_PENDING_DELIVERY_PATTERN, suffix, re.I):
        return True
    if re.search(r"后\s*$", scope):
        return False
    for _, pattern in _FAILURE_SUBJECT_PATTERNS:
        for match in pattern.finditer(clause):
            if match.start() < event.start() < match.end():
                subject_prefix = clause[match.start() : event.start()]
                if subject_prefix and scope.endswith(subject_prefix):
                    scope = scope[: -len(subject_prefix)]
    for _, pattern in _FAILURE_SUBJECT_PATTERNS:
        scope = pattern.sub(" ", scope)
    scope = _ROOT_CAUSE_INSTANCE_PATTERN.sub(" ", scope)
    scope = re.sub(r"[()（）\[\]【】]", " ", scope)
    scope = re.sub(
        r"CDS|的|但是|不过|然而|但|并且|且|并|而|后|前|先前|此前|一度|曾"
        r"|问题|故障|异常|事项|缺陷|本项|该项|该问题|此问题|上述问题"
        r"|该异常|此异常|本根因|该根因|根因"
        r"|重试|复测|验证|再次|重新|二者|全部|均|都|目前|现在|本次|当前"
        r"|和|与|以及|及|、|并且|并|且|验收报告",
        " ",
        scope,
        flags=re.I,
    )
    return bool(re.search(r"[A-Za-z0-9\u4e00-\u9fff]", scope))


def _failure_is_negated(clause, event, previous_event_end):
    """Ignore failure words that the surrounding clause explicitly negates."""
    prefix = clause[max(previous_event_end, event.start() - 12) : event.start()]
    scope = clause[previous_event_end : event.start()]
    suffix = clause[event.end() : event.end() + 12]
    scenario_prefix = clause[max(0, event.start() - 32) : event.start()]
    if re.match(_VERIFIED_SCENARIO_OBJECT_PATTERN, suffix, re.I):
        successful_diagnostic = re.search(
            rf"(?:{_DIAGNOSTIC_MODIFIER_PATTERN}"
            r"|(?:已|已经)(?:验证|测试|检查|覆盖|复测))\s*$",
            scenario_prefix,
            re.I,
        )
        resolved_match = None
        for match in _RESOLVED_FACT_PATTERN.finditer(scenario_prefix):
            resolved_match = match
        resolved_bridge = bool(
            resolved_match
            and re.fullmatch(
                r"\s*(?:对|针对|关于)?\s*",
                scenario_prefix[resolved_match.end() :],
                re.I,
            )
        )
        if successful_diagnostic or resolved_bridge:
            return True
    if re.search(
        r"(?:并未|没有|并非|并不是|不是|不算|未曾|从未|无|未|没)"
        r"(?:发生|出现|处于|被判定为)?\s*$",
        prefix,
        re.I,
    ):
        return True
    for _, pattern in _FAILURE_SUBJECT_PATTERNS:
        scope = pattern.sub(" ", scope)
    scope = _ROOT_CAUSE_INSTANCE_PATTERN.sub(" ", scope)
    scope = re.sub(r"[()（）\[\]【】]", " ", scope)
    scope = re.sub(r"CDS|\s", "", scope, flags=re.I)
    if re.search(
        r"(?:并未|并非|并不是|不是|不算|未曾|从未|无|未|没)"
        r"(?:发生|出现|处于|被判定为)?$"
        r"|(?:未|没|没有)(?:发现|观察到|检测到|证据表明)$"
        r"|(?:0(?:\.0+)?|零|〇)(?:个|次|项)?$",
        scope,
        re.I,
    ):
        return True
    if re.match(
        r"\s*(?:总数|计数|数量|数|率|次数)?\s*"
        r"(?:(?:共计|合计|总计|共)\s*)?(?:为|是|等于|[:：=])?\s*"
        r"(?:0(?:\.0+)?|零|〇)(?![\d一二三四五六七八九十百千万点.])"
        r"(?:个|次|项|%|％)?",
        suffix,
        re.I,
    ):
        return True
    return bool(
        re.match(r"\s*(?:并不存在|不成立|并非事实|不属实|为假)", suffix, re.I)
    )


def _event_inherits_context(clause, event, state, previous_event_end):
    """Allow omitted subjects only for explicit same-subject continuation wording."""
    prefix = clause[previous_event_end : event.start()]
    suffix = clause[event.end() :]
    if re.match(r"\s*的", suffix) and not re.match(
        r"\s*的\s*(?:该|本|此|上述)(?:项|问题|事项|异常|故障|根因)",
        suffix,
        re.I,
    ):
        return False
    normalized = re.sub(
        r"^\s*(?:(?:但是|不过|然而|并且|但|而|并|且)\s*)*",
        "",
        prefix,
        flags=re.I,
    )
    normalized = re.sub(r"[\s'\"“”‘’]+", "", normalized)
    if (
        state == "failed"
        and re.fullmatch(_PENDING_DELIVERY_PATTERN, event.group(0), re.I)
        and re.fullmatch(
            rf"(?:该|本|此|上述)?{_CLOSURE_OBJECT_PATTERN}(?:仍|尚|还|暂时?)?",
            normalized,
            re.I,
        )
    ):
        return True
    if not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", normalized):
        return True
    if re.fullmatch(
        r"(?:(?:该|本|此|上述)?(?:项|问题|事项|异常|故障|根因))"
        r"(?:(?:再次|重新)?(?:重试|复测|验证)(?:结果)?(?:后)?)?"
        r"(?:仍|仍然|依然|再次|重新|当前|目前|现在|本次)?",
        normalized,
        re.I,
    ):
        return True
    if re.fullmatch(
        r"(?:再次|重新)?(?:重试|复测|验证)(?:结果)?(?:后)?"
        r"(?:仍|仍然|依然|再次|重新|当前|目前|现在|本次)?",
        normalized,
        re.I,
    ):
        return True
    if re.fullmatch(
        rf"(?:{_VERIFIED_SCENARIO_OBJECT_PATTERN})+(?:后)?"
        r"(?:但是|但|不过|然而)?(?:再次|重新)?"
        r"(?:重试|复测|验证)(?:结果)?(?:后)?"
        r"(?:仍|仍然|依然|再次|重新|当前|目前|现在|本次)?",
        normalized,
        re.I,
    ):
        return True
    if re.fullmatch(
        r"(?:二者|两者|全部)?(?:均|都)(?:仍|仍然|依然|再次|重新|当前)?"
        r"|(?:二者|两者|全部)",
        normalized,
        re.I,
    ):
        return True
    if re.fullmatch(
        r"(?:随后|最终|再次|重新|依然|仍然|仍|又|此前|先前|一度|曾|"
        r"当前|目前|现在|本次)+",
        normalized,
        re.I,
    ):
        return True
    return bool(
        state == "resolved"
        and re.search(r"后$", normalized, re.I)
    )


def _failure_subject_states(text, initial_states=None, instance_aware=False):
    """Apply ordered status events while keeping context local to this row."""
    states = dict(initial_states or {})
    context_subjects = set()
    for index, clause in enumerate(_split_fact_clauses(text)):
        if index % 2:
            continue
        occurrences = _subject_occurrences(clause, instance_aware=instance_aware)
        explicit_subjects = {name for _, _, name in occurrences}

        events = [
            (match, "failed")
            for match in _FAILURE_FACT_PATTERN.finditer(clause)
        ] + [
            (match, "resolved")
            for match in _RESOLVED_FACT_PATTERN.finditer(clause)
        ]
        events.sort(key=lambda item: item[0].start())
        previous_event_end = 0
        clause_context_subjects = set(explicit_subjects or context_subjects)
        for event, state in events:
            inherits_context = _event_inherits_context(
                clause, event, state, previous_event_end
            )
            subjects = _event_subjects(
                event, occurrences, clause, previous_event_end
            )
            if state == "failed" and _failure_is_negated(
                clause, event, previous_event_end
            ):
                if subjects:
                    clause_context_subjects = subjects
                elif not inherits_context:
                    clause_context_subjects = set()
                previous_event_end = event.end()
                continue
            if state == "resolved" and _closure_changes_subject(
                clause, event, previous_event_end
            ):
                if subjects:
                    clause_context_subjects = subjects
                elif not inherits_context:
                    clause_context_subjects = set()
                previous_event_end = event.end()
                continue
            if (
                not subjects
                and clause_context_subjects
                and inherits_context
            ):
                subjects = clause_context_subjects
            if subjects:
                _apply_subject_state(states, subjects, state)
                clause_context_subjects = subjects
            elif not inherits_context:
                clause_context_subjects = set()
            previous_event_end = event.end()
        if explicit_subjects or events:
            context_subjects = clause_context_subjects
    return states


def _current_failure_subjects(text):
    """Return subjects whose final state is failed within one fact row."""
    states = _failure_subject_states(text)
    return {subject for subject, state in states.items() if state == "failed"}


def _root_cause_state_scope(row, row_index):
    """Keep same-kind gates independent when root-cause targets differ."""
    target = row[0] if row else ""
    gate_subjects = tuple(
        sorted(
            {
                subject
                for _, _, subject in _subject_occurrences(
                    target, instance_aware=True
                )
            }
        )
    )
    if gate_subjects:
        return ("__gate_scope__", gate_subjects)
    normalized = re.sub(r"[`*_\s]+", "", target).lower()
    return normalized or f"__root_cause_row_{row_index}"


def _normalize_evidence_usage_gap_clauses(text):
    """Neutralize evidence-use wording without removing real failures beside it."""
    clauses = _split_fact_clauses(text)
    evidence_subject = r"截图|证据|日志|记录|样本|材料"
    usage_pattern = re.compile(
        rf"({evidence_subject})"
        rf"((?:(?!(?:{evidence_subject}))[^。；;，,|\n]){{0,20}}?)"
        r"(不可用于|无法用于|不能用于)"
        r"(?=[^。；;，,|\n]{0,20}(?:确认|验证|证明|覆盖|判断|评估))",
        re.I,
    )
    evidence_status_pattern = re.compile(
        rf"({evidence_subject})"
        rf"((?:(?!(?:{evidence_subject}))[^。；;，,|\n]){{0,20}}?)"
        r"(?:未成功|没成功|未完成|没完成)"
        r"(?=(?:确认|验证|证明|覆盖|判断|评估))",
        re.I,
    )

    def neutralize_usage(match):
        if _failure_subjects(match.group(2)):
            return match.group(0)
        return f"{match.group(1)}{match.group(2)}不足以用于"

    def neutralize_evidence_status(match):
        if _failure_subjects(match.group(2)):
            return match.group(0)
        return f"{match.group(1)}{match.group(2)}不足以"

    for index in range(0, len(clauses), 2):
        clauses[index] = usage_pattern.sub(neutralize_usage, clauses[index])
        clauses[index] = evidence_status_pattern.sub(
            neutralize_evidence_status, clauses[index]
        )
    return "".join(clauses)


def _daily_fact_signals(values, body):
    """Extract the product and coverage facts used to justify a daily Verdict."""
    product_quality = values.get("产品质量", "").strip()
    completeness = values.get("验收完整性", "").strip()

    severity_counts = _severity_counts_from_text(product_quality)
    has_complete_severity_counts = bool(
        severity_counts is not None and len(severity_counts) == 4
    )
    zero_defects = bool(
        (
            has_complete_severity_counts
            and sum(severity_counts.values()) == 0
        )
        or (
            not has_complete_severity_counts
            and re.search(
                r"(?:未发现|没有发现|未检测到|无|不存在)\s*"
                r"(?:(?:任何|明确|已知|可(?:稳定)?复现(?:的)?|目标日|产品)\s*){0,5}缺陷"
                r"|(?:缺陷(?:数(?:量)?)?)[^。；;|\n]{0,12}(?:为|[:：=])\s*0(?:\s*个)?"
                r"|\b0\s*/\s*0\s*/\s*0\s*/\s*0\b",
                product_quality,
                re.I,
            )
        )
    )

    positive_product = re.sub(
        r"(?:未发现|没有发现|未检测到|无|没有|未出现|不存在)"
        r"[^。；;，,|\n]{0,32}(?:缺陷|失败|错误|阻断|不通过)",
        " ",
        product_quality,
        flags=re.I,
    )
    positive_product = _strip_severity_count_claims(positive_product)

    defect_headers, defect_rows = _section_table(body, "缺陷清单")
    severity_index = next(
        (
            index
            for index, header in enumerate(defect_headers)
            if re.search(r"严重(?:级|程度)|severity", header, re.I)
        ),
        -1,
    )
    blocking_defect_rows = (
        severity_index >= 0
        and any(
            severity_index < len(row)
            and bool(re.search(r"\bP[01]\b", row[severity_index], re.I))
            for row in defect_rows
        )
    )
    nonblocking_defect_rows = (
        severity_index >= 0
        and any(
            severity_index < len(row)
            and bool(re.search(r"\bP[23]\b", row[severity_index], re.I))
            for row in defect_rows
        )
    )
    blocking_count = bool(
        severity_counts
        and (severity_counts.get("P0", 0) > 0 or severity_counts.get("P1", 0) > 0)
    )
    nonblocking_count = bool(
        severity_counts
        and (severity_counts.get("P2", 0) > 0 or severity_counts.get("P3", 0) > 0)
    )
    blocking_product_failure = bool(
        blocking_count
        or blocking_defect_rows
        or re.search(
            r"\bP[01]\b"
            r"|产品[^。；;|\n]{0,20}(?:失败|阻断|不通过)",
            positive_product,
            re.I,
        )
    )
    nonblocking_product_risk = bool(
        nonblocking_count
        or nonblocking_defect_rows
        or re.search(r"\bP[23]\b|非阻断风险", positive_product, re.I)
    )
    product_core_failure = "core-case" in _current_failure_subjects(
        positive_product
    )
    product_risk = blocking_product_failure or nonblocking_product_risk
    root_cause_headers, root_cause_rows = _section_table(body, "根因链条")
    failure_states_by_scope = {}
    for row_index, row in enumerate(root_cause_rows):
        scope = _root_cause_state_scope(row, row_index)
        normalized_row = "；".join(
            _normalize_evidence_usage_gap_clauses(cell)
            for cell in row[:5]
        )
        failure_states_by_scope[scope] = _failure_subject_states(
            normalized_row,
            failure_states_by_scope.get(scope),
            instance_aware=True,
        )
    current_failure_subjects = {
        subject[0] if isinstance(subject, tuple) else subject
        for states in failure_states_by_scope.values()
        for subject, state in states.items()
        if state == "failed"
    }
    chain_failure = bool(
        current_failure_subjects
        & {
            "acceptance-chain",
            "evidence-chain",
            "archive",
            "report-publish",
            "verify-open",
            "slack",
        }
    )
    hard_gate_failure = bool(
        current_failure_subjects
        & {"ready", "smoke", "build", "service-ready", "forced-test"}
    )
    core_failure = product_core_failure or "core-case" in current_failure_subjects
    coverage_gap_count = _coverage_gap_count(body)
    completeness_with_zero_gaps_removed = _strip_zero_coverage_gap_phrases(completeness)
    incomplete = bool(
        coverage_gap_count > 0
        or re.search(
            r"不完整|无法确认|未覆盖|覆盖不足|覆盖缺口|\d+\s*项?缺口",
            completeness_with_zero_gaps_removed,
            re.I,
        )
    )
    claims_complete = bool(re.search(r"(?:^|[：:；;，,\s])完整(?:$|[；;，,\s])", completeness))

    return {
        "zero_defects": zero_defects,
        "blocking_product_failure": blocking_product_failure,
        "nonblocking_product_risk": nonblocking_product_risk,
        "product_risk": product_risk,
        "core_failure": core_failure,
        "chain_failure": chain_failure,
        "hard_gate_failure": hard_gate_failure,
        "coverage_gap_count": coverage_gap_count,
        "incomplete": incomplete,
        "claims_complete": claims_complete,
    }


def _daily_conclusion_contract_errors(verdict, body):
    """Keep product quality, acceptance completeness and delivery judgment distinct.

    A coverage-only gap must not be rendered as a product failure. Requiring a
    small structured contract makes the report readable to humans and gives the
    archive gate a deterministic consistency check.
    """
    errors = []
    conclusion_text = _section_text(body, "结论分层")
    conclusion_rows = _section_table_rows(body, "结论分层")
    if not conclusion_text or not conclusion_rows:
        return ["[结论语义] 每日验收缺少实质填写的「结论分层」表"]

    values = {}
    for row in conclusion_rows:
        if len(row) >= 2:
            values[re.sub(r"[`*_\s]", "", row[0])] = row[1].strip()

    for field in DAILY_CONCLUSION_FIELDS:
        if not values.get(field):
            errors.append(f"[结论语义] 「结论分层」缺少「{field}」字段或结果")

    nature = re.sub(r"[`*_\s]", "", values.get("判定性质", ""))
    allowed = VERDICT_NATURES.get(verdict, set())
    if nature and nature not in allowed:
        expected = "/".join(sorted(allowed)) or "合法判定性质"
        errors.append(
            f"[Verdict 语义] verdict={verdict} 与判定性质「{nature}」不一致；"
            f"该 Verdict 只允许：{expected}。覆盖不足且无真实失败时必须用 conditional"
        )

    overall = re.sub(r"[`*_\s（）()/／·-]", "", values.get("综合结论", "")).lower()
    overall_matches = {
        "pass": overall in {"pass", "通过", "pass通过"},
        "conditional": overall in {"conditional", "有条件通过", "conditional有条件通过"},
        "fail": overall in {"fail", "不通过", "fail不通过"},
    }
    if overall and not overall_matches.get(verdict, False):
        errors.append(
            f"[Verdict 语义] verdict={verdict} 与综合结论「{values.get('综合结论')}」不一致"
        )

    facts = _daily_fact_signals(values, body)
    if facts["zero_defects"] and facts["product_risk"]:
        errors.append("[事实一致性] 产品质量同时声称缺陷为 0/未发现缺陷，又报告了 P0-P3 缺陷事实")
    if facts["claims_complete"] and facts["coverage_gap_count"] > 0:
        errors.append(
            f"[事实一致性] 验收完整性声称完整，但覆盖缺口表仍有 {facts['coverage_gap_count']} 项"
        )
    if nature == "产品失败" and not facts["blocking_product_failure"]:
        errors.append("[事实一致性] 判定性质为产品失败，但产品质量和缺陷清单没有 P0/P1 产品失败事实")
    if nature == "核心用例失败" and not facts["core_failure"]:
        errors.append("[事实一致性] 判定性质为核心用例失败，但产品质量没有核心用例/流程失败事实")
    if nature == "验收链路失败" and not facts["chain_failure"]:
        errors.append("[事实一致性] 判定性质为验收链路失败，但根因链没有归档、打开验证或通知链路失败事实")
    if nature == "硬门禁失败" and not facts["hard_gate_failure"]:
        errors.append("[事实一致性] 判定性质为硬门禁失败，但根因链没有 ready、smoke、构建或强制测试失败事实")
    if nature == "覆盖不足" and not facts["incomplete"]:
        errors.append("[事实一致性] 判定性质为覆盖不足，但验收完整性和覆盖缺口没有缺口事实")
    if verdict == "pass" and (facts["incomplete"] or facts["product_risk"]):
        errors.append("[事实一致性] pass 与未覆盖/无法确认或 P0-P3 缺陷事实不一致")
    if verdict == "conditional" and facts["blocking_product_failure"]:
        errors.append("[事实一致性] 已有 P0/P1 产品失败事实时不能使用 conditional，必须使用 fail")
    if verdict in {"pass", "conditional"}:
        fail_only_facts = [
            label
            for label, present in (
                ("核心用例", facts["core_failure"]),
                ("验收链路", facts["chain_failure"]),
                ("硬门禁", facts["hard_gate_failure"]),
            )
            if present
        ]
        if fail_only_facts:
            errors.append(
                f"[事实一致性] verdict={verdict} 与"
                + "、".join(fail_only_facts)
                + "失败事实不一致，必须使用 fail"
            )
    coverage_only = (
        facts["zero_defects"]
        and facts["incomplete"]
        and not facts["product_risk"]
        and not facts["core_failure"]
        and not facts["chain_failure"]
        and not facts["hard_gate_failure"]
    )
    if verdict == "fail" and coverage_only:
        errors.append(
            "[Verdict 语义] 已报事实仅支持覆盖不足且未发现产品失败，必须使用 conditional"
        )

    root_cause_text = _section_text(body, "根因链条")
    root_cause_headers, root_cause_rows = _section_table(body, "根因链条")
    if verdict in {"conditional", "fail"} and (not root_cause_text or not root_cause_rows):
        errors.append("[根因链] 每日验收缺少实质填写的「根因链条」表")
    elif root_cause_text or root_cause_rows:
        normalized_headers = [re.sub(r"[`*_\s]", "", cell) for cell in root_cause_headers]
        if normalized_headers != list(DAILY_ROOT_CAUSE_FIELDS):
            errors.append(
                "[根因链] 表头必须严格为：" + "、".join(DAILY_ROOT_CAUSE_FIELDS)
            )
        malformed_rows = [
            index
            for index, row in enumerate(root_cause_rows, start=1)
            if len(row) != len(DAILY_ROOT_CAUSE_FIELDS)
            or any(not cell.strip() for cell in row)
        ]
        if malformed_rows:
            errors.append(
                "[根因链] 每条数据必须完整填写六列；无效数据行："
                + "、".join(str(index) for index in malformed_rows)
            )

    return errors


def _coverage_gap_count(markdown):
    """Count distinct coverage gaps from the report's structured source of truth.

    Daily reports commonly repeat the same G1..Gn items in both "覆盖缺口" and
    "总缺口账本". The ledger is authoritative; counting matching words across
    the whole document makes the header depend on prose wording and can disagree
    with both tables.
    """
    for heading in ("总缺口账本", "覆盖缺口"):
        rows = _section_table_rows(markdown, heading)
        if rows:
            keys = set()
            for row in rows:
                first = re.sub(r"[`*_]", "", row[0]).strip().upper() if row else ""
                keys.add(first or "\x1f".join(cell.strip() for cell in row))
            return len(keys)

    explicit = re.search(r"覆盖缺口\s*[：:]\s*(\d+)\s*个?", markdown or "", re.I)
    if explicit:
        return int(explicit.group(1))

    gap_ids = {
        re.sub(r"[-_\s]", "", match.group(1)).upper()
        for match in re.finditer(r"^\|\s*(G[-_\s]?\d+)\s*\|", markdown or "", re.M | re.I)
    }
    if gap_ids:
        return len(gap_ids)

    legacy_lines = set()
    for line in (markdown or "").splitlines():
        stripped = line.strip()
        positive_gap_text = _strip_zero_coverage_gap_phrases(stripped)
        if (
            not re.match(r"^#{1,6}\s", stripped)
            and re.search(r"未覆盖|not-run|未深测|弱相关|无关", positive_gap_text, re.I)
        ):
            legacy_lines.add(re.sub(r"\s+", " ", stripped))
    return len(legacy_lines)


def _extract_report_time(markdown):
    """Read the visible report timestamp already injected into the report body."""
    text = markdown or ""
    section = re.search(
        r"^##\s*(?:验收时间|报告时间|生成时间)\s*$\n+\s*([^\n|#][^\n]*)",
        text,
        re.M,
    )
    if section:
        return re.sub(r"[`*_]", "", section.group(1)).strip()

    table = re.search(
        r"^\|\s*(?:验收时间|报告时间|生成时间)\s*\|\s*([^|\n]+)",
        text,
        re.M,
    )
    if table:
        return re.sub(r"[`*_]", "", table.group(1)).strip()

    meta = re.search(r"^date:\s*([^\n]+)", text, re.M)
    return meta.group(1).strip() if meta else ""


def _render_table(rows):
    if len(rows) < 2:
        return ""
    parsed = [_split_markdown_table_row(row) for row in rows]
    header = parsed[0]
    body_rows = parsed[2:] if re.match(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$", rows[1]) else parsed[1:]
    th = "".join(f"<th>{_render_inline(c)}</th>" for c in header)
    body = []
    for row in body_rows:
        row_text = " ".join(row)
        cls = []
        severity = _severity_from_text(row_text)
        if severity == "P0":
            cls.append("row-fail")
        elif severity in {"P1", "P2"} or re.search(r"P1|有缺陷|conditional|风险", _strip_negated_problem_phrases(row_text), re.I):
            cls.append("row-risk")
        elif re.search(r"未覆盖|not-run|未深测|弱相关|无关", row_text, re.I):
            cls.append("row-gap")
        tds = "".join(f"<td>{_render_inline(c)}</td>" for c in row)
        body.append(f'<tr class="{" ".join(cls)}">{tds}</tr>')
    return '<div class="table-wrap"><table><thead><tr>' + th + "</tr></thead><tbody>" + "".join(body) + "</tbody></table></div>"


def _figure_src_map(markdown):
    """从已组装的 Markdown 里取图号对应的最终图片 src。

    local 模式这里会是相对路径；CDS 模式这里会是 data-URI，入库后再由服务端抽成
    report asset。HTML 证据画廊必须复用这个 src，不能引用 manifest 里的本地绝对路径。
    """
    srcs = {}
    block_pat = re.compile(
        r'<span id="(fig-[a-z0-9-]+)" class="figure-anchor"></span>(.*?)(?=<span id="fig-[a-z0-9-]+" class="figure-anchor"></span>|<!-- acceptance-meta|$)',
        re.I | re.S,
    )
    img_pat = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
    for m in block_pat.finditer(markdown or ""):
        img = img_pat.search(m.group(2))
        if img:
            srcs[m.group(1)] = img.group(1).strip()
    return srcs


class _EvidenceHtmlParser(HTMLParser):
    """Collect the relationships that must stay lossless in an archived report."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.figure_hrefs = []
        self.cards = []
        self.back_links = 0
        self.side_tabs = []
        self.directory_hrefs = []
        self.mobile_nav_toggles = 0
        self._card = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        element_id = values.get("id")
        if element_id:
            self.ids.append(element_id)
        href = values.get("href", "")
        if href.startswith("#fig-"):
            self.figure_hrefs.append(href[1:])
        classes = set(values.get("class", "").split())
        if href == "#evidence-gallery" and "figure-back-link" in classes:
            self.back_links += 1
        if tag == "button" and values.get("data-side-tab"):
            self.side_tabs.append(values["data-side-tab"])
        if tag == "button" and "data-mobile-nav-toggle" in values:
            self.mobile_nav_toggles += 1
        if tag == "a" and "section-nav-item" in classes and href.startswith("#"):
            self.directory_hrefs.append(href[1:])
        if tag == "a" and "evidence-card" in classes:
            self._card = {
                "href": href[1:] if href.startswith("#") else href,
                "has_image": False,
                "has_placeholder": False,
            }
            self.cards.append(self._card)
        elif self._card is not None and tag == "img":
            self._card["has_image"] = bool(values.get("src", "").strip())
        elif self._card is not None and "thumb-placeholder" in classes:
            self._card["has_placeholder"] = True

    def handle_endtag(self, tag):
        if tag == "a" and self._card is not None:
            self._card = None


def _manifest_figure_errors(manifest):
    errors = []
    names = [(shot.get("name") or "").strip() for shot in manifest or []]
    anchors = [_figure_anchor(_figure_key(name)) for name in names]
    if any(not name for name in names):
        errors.append("[证据关系] manifest 存在空 name，无法生成稳定图号和锚点")
    duplicate_names = sorted({name for name in names if names.count(name) > 1})
    if duplicate_names:
        errors.append("[证据关系] manifest 截图名重复：" + "、".join(duplicate_names))
    invalid_names = [name for name, anchor in zip(names, anchors) if name and not anchor]
    if invalid_names:
        errors.append("[证据关系] manifest 截图名无法生成锚点：" + "、".join(invalid_names))
    duplicate_anchors = sorted({anchor for anchor in anchors if anchor and anchors.count(anchor) > 1})
    if duplicate_anchors:
        errors.append("[证据关系] manifest 生成了重复锚点：" + "、".join(duplicate_anchors))
    return errors


def _interactive_evidence_errors(html_content, manifest):
    """Bidirectional gate: manifest, cards, thumbnails, hrefs and body anchors agree."""
    errors = _manifest_figure_errors(manifest)
    parser = _EvidenceHtmlParser()
    parser.feed(html_content or "")
    expected = [
        _figure_anchor(_figure_key(shot.get("name")))
        for shot in manifest or []
        if _figure_anchor(_figure_key(shot.get("name")))
    ]
    id_counts = {element_id: parser.ids.count(element_id) for element_id in set(parser.ids)}

    for anchor in expected:
        count = id_counts.get(anchor, 0)
        if count != 1:
            errors.append(f"[证据关系] 正文锚点 {anchor} 应出现 1 次，实际 {count} 次")

    card_targets = [card["href"] for card in parser.cards]
    if card_targets != expected:
        errors.append(
            "[证据关系] 缩略图卡片顺序/目标与 manifest 不一致："
            f"expected={expected} actual={card_targets}"
        )
    for index, card in enumerate(parser.cards, start=1):
        if not card["has_image"] or card["has_placeholder"]:
            errors.append(f"[证据关系] 第 {index} 张证据卡缺少真实缩略图")

    if id_counts.get("evidence-gallery", 0) != 1:
        errors.append(
            f"[证据关系] 证据列表锚点 evidence-gallery 应出现 1 次，实际 {id_counts.get('evidence-gallery', 0)} 次"
        )
    if parser.back_links != len(expected):
        errors.append(
            f"[证据关系] 每张正文证据必须有一个返回证据列表入口：expected={len(expected)} actual={parser.back_links}"
        )
    if parser.side_tabs != ["evidence", "contents"]:
        errors.append(
            "[报告导航] 左上角必须按顺序提供 evidence/contents 两个 Tab："
            f"actual={parser.side_tabs}"
        )
    if parser.mobile_nav_toggles != 1 or id_counts.get("mobile-nav-drawer", 0) != 1:
        errors.append(
            "[报告导航] 移动端必须提供一个可折叠导航按钮和一个抽屉："
            f"toggle={parser.mobile_nav_toggles} drawer={id_counts.get('mobile-nav-drawer', 0)}"
        )
    if not parser.directory_hrefs:
        errors.append("[报告导航] 报告目录不能为空")
    unresolved_sections = sorted({
        section_id for section_id in parser.directory_hrefs
        if id_counts.get(section_id, 0) != 1
    })
    if unresolved_sections:
        errors.append("[报告导航] 目录存在无法唯一解析的章节：" + "、".join(unresolved_sections))

    unresolved = sorted({anchor for anchor in parser.figure_hrefs if id_counts.get(anchor, 0) != 1})
    if unresolved:
        errors.append("[证据关系] 存在无法唯一解析的图链接：" + "、".join(unresolved))
    return errors


def _duplicate_evidence_errors(manifest):
    """Reject accidental evidence cloning unless the manifest declares it explicitly."""
    errors = []
    digest_by_name = {}
    shot_by_name = {}

    def file_digest(path):
        digest = hashlib.sha256()
        with open(path, "rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    for shot in manifest or []:
        name = (shot.get("name") or "").strip()
        path = shot.get("path") or ""
        if not name or not os.path.isfile(path):
            continue
        digest_by_name[name] = file_digest(path)
        shot_by_name[name] = shot

    for name, shot in shot_by_name.items():
        duplicate_of = (shot.get("duplicateOf") or "").strip()
        if not duplicate_of:
            continue
        if duplicate_of not in digest_by_name:
            errors.append(f"[证据关系] {name} 的 duplicateOf 指向不存在的截图：{duplicate_of}")
        elif digest_by_name[name] != digest_by_name[duplicate_of]:
            errors.append(f"[证据关系] {name} 声明 duplicateOf={duplicate_of}，但文件内容不同")

    groups = {}
    for name, digest in digest_by_name.items():
        groups.setdefault(digest, []).append(name)
    for names in groups.values():
        if len(names) < 2:
            continue
        declared = {
            name for name in names
            if (shot_by_name[name].get("duplicateOf") or "").strip() in names
        }
        undeclared = [name for name in names[1:] if name not in declared]
        if undeclared:
            errors.append(
                "[证据关系] 多张截图文件完全相同却声明不同验证语义："
                + "、".join(names)
                + "。确认是复用证据时，为后续截图设置 duplicateOf"
            )
    return errors


NEGATED_PROBLEM_PAT = re.compile(
    r"(?:无|没有|未发现|未出现|未再|不再|未检测到|不存在|没有发现|没有检测到)"
    r"[^。；;，,\n]{0,32}"
    r"(?:撑破|挤出|超出|溢出|错位|遮挡|阻断|失败|错误|空白|崩溃|不通过|未通过)",
    re.I,
)


def _strip_negated_problem_phrases(text):
    """Remove negative success statements before severity extraction.

    Example: "没有文字挤出或面板撑破" is a pass statement, not a P0.
    """
    return NEGATED_PROBLEM_PAT.sub(" ", text or "")


def _severity_from_text(text):
    raw = text or ""
    stripped = _strip_negated_problem_phrases(raw)
    if re.search(r"\bP0\b|阻断|未通过|不通过|\bfail\b|撑破|挤出|超出|溢出", stripped, re.I):
        return "P0"
    if re.search(r"\bP1\b|必修|高风险", stripped, re.I):
        return "P1"
    if re.search(r"\bP2\b|有缺陷|风险|conditional|弱相关", stripped, re.I):
        return "P2"
    if re.search(r"\bP3\b|优化建议", stripped, re.I):
        return "P3"
    return ""


def _severity_class(severity):
    if severity == "P0":
        return "fail"
    if severity in {"P1", "P2"}:
        return "risk"
    if severity == "P3":
        return "gap"
    return ""


def _plain_cell_text(value):
    """把表格单元格里的 markdown 标记压成纯文本。

    重点卡直接把整行单元格拼给读者，若保留 `[图05](#fig-05-defect)` 这类原始语法，
    卡片上就会出现一串未渲染的方括号和井号，观感等同于半成品。锚点由调用方
    在压平之前从原始行里取，这里只负责显示层。
    """
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", value or "")
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = text.replace("`", "")
    return re.sub(r"\s+", " ", text).strip()


def _collect_problem_items(markdown, manifest):
    items = []
    seen = set()
    seen_anchor_severity = set()

    def add(severity, title, detail, anchor="", badge=""):
        sev = severity or _severity_from_text(" ".join([title or "", detail or ""]))
        if not sev:
            return
        if anchor:
            anchor_key = (sev, anchor)
            if anchor_key in seen_anchor_severity:
                return
            seen_anchor_severity.add(anchor_key)
        key = (sev, title or "", detail or "", anchor or "")
        if key in seen:
            return
        seen.add(key)
        items.append({
            "severity": sev,
            "title": (title or "").strip(),
            "detail": (detail or "").strip(),
            "anchor": anchor,
            "badge": (badge or sev).strip(),
        })

    def section_table_rows(section_name):
        in_section = False
        table_rows = []
        for line in (markdown or "").splitlines():
            stripped = line.strip()
            if re.match(rf"^##\s+{re.escape(section_name)}(?:\s|$)", stripped):
                in_section = True
                continue
            if in_section and stripped.startswith("## "):
                break
            if in_section and stripped.startswith("|"):
                table_rows.append(stripped)
            elif in_section and table_rows:
                break
        if len(table_rows) < 3:
            return [], []
        return _split_markdown_table_row(table_rows[0]), [
            _split_markdown_table_row(row) for row in table_rows[2:]
        ]

    def column_index(headers, pattern):
        for index, header in enumerate(headers):
            if re.search(pattern, header, re.I):
                return index
        return -1

    # 缺陷表允许 `严重级` 不在首列。每日验收常用 `ID | 严重级 | 页面/路径 | 现象...`，
    # 旧实现只读首列，导致 conditional 报告顶部显示 0 个风险且完全没有重点卡。
    defect_headers, defect_rows = section_table_rows("缺陷清单")
    severity_index = column_index(defect_headers, r"严重(?:级|程度)|severity")
    id_index = column_index(defect_headers, r"^(?:id|编号|缺陷号)$")
    symptom_index = column_index(defect_headers, r"现象|问题|异常")
    page_index = column_index(defect_headers, r"页面|路径|模块|位置")
    for cells in defect_rows:
        if len(cells) < 2:
            continue
        severity = ""
        if 0 <= severity_index < len(cells):
            severity = cells[severity_index].strip()
        if not re.fullmatch(r"P[0-3]", severity, re.I):
            severity = next(
                (cell.strip() for cell in cells if re.fullmatch(r"P[0-3]", cell.strip(), re.I)),
                "",
            )
        if not severity:
            continue
        defect_id = cells[id_index].strip() if 0 <= id_index < len(cells) else ""
        symptom = cells[symptom_index].strip() if 0 <= symptom_index < len(cells) else ""
        page = cells[page_index].strip() if 0 <= page_index < len(cells) else ""
        title_parts = [part for part in (defect_id, symptom or page or "缺陷") if part]
        anchor_m = re.search(r"#(fig-[a-z0-9-]+)", "；".join(cells), re.I)
        # 标题已经带上编号和现象，明细里再重复一遍只是噪声；同时压平 markdown 语法。
        skip = {defect_id.strip(), severity.strip(), (symptom or "").strip()}
        row_text = "；".join(
            _plain_cell_text(cell)
            for cell in cells
            if cell.strip() and cell.strip() not in skip and _plain_cell_text(cell)
        )
        add(
            severity.upper(),
            " · ".join(title_parts),
            row_text,
            anchor_m.group(1) if anchor_m else "",
            severity.upper(),
        )

    # `有条件通过` 的重点不仅是已确认缺陷，也包括明确未覆盖的条件。优先读取
    # 总缺口账本，缺失时回退覆盖缺口，并以 P3 展示层级渲染但保留 G1/GAP-01 徽标。
    gap_headers, gap_rows = section_table_rows("总缺口账本")
    if not gap_rows:
        gap_headers, gap_rows = section_table_rows("覆盖缺口")
    gap_id_index = column_index(gap_headers, r"^(?:id|编号|缺口|缺口编号)$")
    gap_title_index = column_index(gap_headers, r"未覆盖|缺口|内容|事项|项目")
    for cells in gap_rows:
        gap_id = cells[gap_id_index].strip() if 0 <= gap_id_index < len(cells) else ""
        if not re.fullmatch(r"(?:G\d+|GAP[-_ ]?\d+)", gap_id, re.I):
            gap_id = next(
                (
                    cell.strip()
                    for cell in cells
                    if re.fullmatch(r"(?:G\d+|GAP[-_ ]?\d+)", cell.strip(), re.I)
                ),
                "",
            )
        if not gap_id:
            continue
        gap_title = (
            cells[gap_title_index].strip()
            if 0 <= gap_title_index < len(cells) and cells[gap_title_index].strip() != gap_id
            else next((cell.strip() for cell in cells if cell.strip() and cell.strip() != gap_id), "未覆盖项")
        )
        row_text = "；".join(
            _plain_cell_text(cell)
            for cell in cells
            if cell.strip() and cell.strip() not in {gap_id, gap_title} and _plain_cell_text(cell)
        )
        add("P3", f"{gap_id} · {gap_title}", row_text, badge=gap_id)

    for shot in manifest or []:
        key = _figure_key(shot.get("name"))
        anchor = _figure_anchor(key)
        num = _figure_number(shot.get("name")) or key
        label = f"图{num.upper()}" if num else (shot.get("name") or "截图")
        cap = shot.get("caption") or shot.get("name") or label
        for warning in shot.get("warnings") or []:
            add(_severity_from_text(warning), f"{label} · {cap}", warning, anchor)

    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    return sorted(items, key=lambda it: order.get(it["severity"], 9))


def _collect_section_navigation(markdown, problem_items):
    """Build a deterministic H2 directory and mark sections that contain problems."""
    lines = (markdown or "").splitlines()
    sections = []
    anchor_lines = {}
    for index, line in enumerate(lines):
        stripped = line.strip()
        heading = re.match(r"^##\s+(.+)$", stripped)
        if heading:
            title = heading.group(1).strip()
            sections.append({
                "title": title,
                "id": _html_id(title, f"section-{index}"),
                "line": index,
                "problems": [],
            })
        anchor = re.fullmatch(r'<span id="(fig-[a-z0-9-]+)" class="figure-anchor"></span>', stripped)
        if anchor:
            anchor_lines[anchor.group(1)] = index

    def add_problem(section, item):
        key = (item.get("severity"), item.get("badge"), item.get("anchor"), item.get("title"))
        existing = {
            (entry.get("severity"), entry.get("badge"), entry.get("anchor"), entry.get("title"))
            for entry in section["problems"]
        }
        if key not in existing:
            section["problems"].append(item)

    for item in problem_items or []:
        target_line = anchor_lines.get(item.get("anchor") or "")
        if target_line is not None:
            containing = [
                section for section in sections
                if section["line"] <= target_line
            ]
            if containing:
                add_problem(containing[-1], item)
        severity = item.get("severity")
        fallback_pattern = r"缺口" if severity == "P3" else r"缺陷清单"
        fallback = next(
            (section for section in sections if re.search(fallback_pattern, section["title"])),
            None,
        )
        if fallback:
            add_problem(fallback, item)

    severity_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    for section in sections:
        severities = [item.get("severity") for item in section["problems"] if item.get("severity")]
        section["severity"] = min(severities, key=lambda value: severity_order.get(value, 9)) if severities else ""
        badges = []
        for item in section["problems"]:
            badge = item.get("badge") or item.get("severity")
            if badge and badge not in badges:
                badges.append(badge)
        section["badges"] = badges
    return sections


def markdown_to_html(markdown):
    meta = ""
    m = re.search(r"\n?<!-- acceptance-meta.*?-->\s*$", markdown, re.S)
    if m:
        meta = m.group(0)
        markdown = markdown[:m.start()]
    lines = markdown.splitlines()
    out = []
    i = 0
    in_code = False
    code_buf = []
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("```"):
            if in_code:
                out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
                code_buf = []
                in_code = False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue
        if not stripped:
            i += 1
            continue
        if re.fullmatch(r'<span id="fig-[a-z0-9-]+" class="figure-anchor"></span>', stripped):
            out.append(stripped)
            i += 1
            continue
        if stripped.startswith("|") and i + 1 < len(lines) and lines[i + 1].strip().startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            out.append(_render_table(rows))
            continue
        hm = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if hm:
            level = len(hm.group(1))
            text = hm.group(2).strip()
            hid = _html_id(text, f"section-{i}")
            out.append(f'<h{level} id="{hid}">{_render_inline(text)}</h{level}>')
            if level == 2:
                note = _method_note(text)
                if note:
                    out.append(note)
            i += 1
            continue
        if stripped.startswith(">"):
            out.append(f"<blockquote>{_render_inline(stripped.lstrip('> ').strip())}</blockquote>")
            i += 1
            continue
        if re.match(r"^[-*]\s+", stripped):
            items = []
            while i < len(lines) and re.match(r"^[-*]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[i].strip()))
                i += 1
            out.append("<ul>" + "".join(f"<li>{_render_inline(item)}</li>" for item in items) + "</ul>")
            continue
        if re.match(r"^\d+\.\s+", stripped):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i].strip()))
                i += 1
            out.append("<ol>" + "".join(f"<li>{_render_inline(item)}</li>" for item in items) + "</ol>")
            continue
        out.append(f"<p>{_render_inline(stripped)}</p>")
        i += 1
    if in_code:
        out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
    return "\n".join(out) + (meta or "")


def _decorate_problem_figures(body_html, problem_anchors):
    """Stamp real failed or conditional evidence images only.

    Pass evidence may mention "no overflow" or "no breakage" in captions; those
    must not turn red/yellow. Styling is driven by structured defect rows or
    automated warnings mapped to anchors.
    """
    for anchor, severity in (problem_anchors or {}).items():
        if severity not in {"P0", "P1", "P2"}:
            continue
        marker = f'<span id="{anchor}" class="figure-anchor"></span>'
        if marker in body_html:
            status_class = "fail" if severity == "P0" else "risk"
            label = f"验收失败 · {severity}" if severity == "P0" else f"有条件风险 · {severity}"
            body_html = body_html.replace(
                marker,
                marker
                + f'<div class="figure-problem-banner is-{status_class}" '
                + f'data-label="{html.escape(label, quote=True)}" '
                + f'aria-label="{html.escape(label, quote=True)}">{html.escape(label)}</div>',
                1,
            )
    return body_html


def _wrap_body_figures(body_html, manifest, figure_srcs=None):
    """把正文里的「锚点 + 图片段落」升级成档案图版（figure）。

    旧版正文只有裸 `<p><img></p>`：没有图号、没有图注、失败标签靠
    `.figure-problem-banner + p::before` 取 `attr(data-label)`，而属性写在 banner 上、
    伪元素挂在段落上，渲染出来是一个没有文字的色块。这里改成显式结构：
    图注（图号 + 说明 + 状态标签 + 放大入口）在上，图版在下，底部给返回证据列表入口。
    放大入口本身是指向图片地址的普通链接，禁用 JS 时仍可直接打开原图。
    """
    figure_srcs = dict(figure_srcs or {})
    for shot in manifest or []:
        key = _figure_key(shot.get("name"))
        anchor = _figure_anchor(key)
        if not anchor:
            continue
        marker = f'<span id="{anchor}" class="figure-anchor"></span>'
        marker_at = body_html.find(marker)
        if marker_at < 0:
            continue
        cursor = marker_at + len(marker)
        banner = ""
        banner_match = re.match(
            r'\s*<div class="figure-problem-banner[^>]*>.*?</div>',
            body_html[cursor:],
            re.S,
        )
        if banner_match:
            banner = banner_match.group(0).strip()
            cursor += banner_match.end()
        next_anchor = body_html.find('<span id="fig-', cursor)
        search_end = next_anchor if next_anchor >= 0 else len(body_html)
        image_at = body_html.find("<img ", cursor, search_end)
        if image_at < 0:
            continue
        para_start = body_html.rfind("<p>", cursor, image_at)
        if para_start < 0:
            continue
        para_end = body_html.find("</p>", image_at, search_end)
        if para_end < 0:
            continue
        para_end += len("</p>")
        plate = body_html[para_start + len("<p>"):para_end - len("</p>")]
        num = (_figure_number(shot.get("name")) or key).upper()
        caption = html.escape(shot.get("caption") or shot.get("name") or f"图{num}")
        src = html.escape(figure_srcs.get(anchor, ""), quote=True)
        status = ""
        if 'is-fail' in banner:
            status = "fail"
        elif 'is-risk' in banner:
            status = "risk"
        zoom = (
            f'<a class="shot-zoom" href="{src}" target="_blank" rel="noopener noreferrer" '
            f'data-lb-open="{html.escape(anchor, quote=True)}">放大查看</a>'
            if src else ""
        )
        figure_class = f"shot is-{status}" if status else "shot"
        figure_html = (
            f'<figure class="{figure_class}" data-lb-src="{src}" '
            f'data-lb-no="图{html.escape(num, quote=True)}" data-lb-cap="{caption}">'
            f'<figcaption class="shot-head">'
            f'<span class="shot-no">图 {html.escape(num)}</span>'
            f'<span class="shot-cap">{caption}</span>'
            f'{banner}{zoom}</figcaption>'
            f'<div class="shot-frame">{plate}</div>'
            f'<div class="shot-foot">'
            f'<a class="figure-back-link" data-return-evidence="true" '
            f'href="#evidence-gallery" aria-label="图{html.escape(num, quote=True)}返回证据列表">'
            f'返回证据列表</a></div>'
            f'</figure>'
        )
        body_html = body_html[:marker_at] + marker + figure_html + body_html[para_end:]
    return body_html


def build_interactive_html(
    title,
    verdict,
    markdown_content,
    manifest,
    flavor="acceptance",
    figure_srcs=None,
    report_version="v0.9",
):
    """交互式验收 HTML（模板契约 interactive-html-v2 不变，皮肤为「米多刊系」检验档案风）。

    flavor 决定刊头身份（.claude/rules/report-design-system.md）：
      - acceptance（默认）：单次验收 =「MAP 验收档案」，身份色青碧
      - daily：每日视觉验收 =「每日巡检特刊」，身份色钢蓝
    结构性 class（layout/hero/evidence-nav/reportBody 等）与模板标记保持逐字节兼容，
    CDS reports.ts 的 validateAcceptanceHtmlTemplate 与 gate 测试依赖它们。
    """
    _FLAVORS = {
        "acceptance": {
            "cn": "MAP 验收档案", "en": "ACCEPTANCE DOSSIER",
            "accent": "#0f766e", "accent_soft": "rgba(15,118,110,0.08)",
            "byline": "验收智能体 · 自动编档",
            "section_label": "档案",
        },
        "daily": {
            "cn": "每日巡检特刊", "en": "DAILY PATROL EDITION",
            "accent": "#3b5f8a", "accent_soft": "rgba(59,95,138,0.08)",
            "byline": "每日全量巡检 · 自动编档",
            "section_label": "巡检",
        },
    }
    fl = _FLAVORS.get(flavor) or _FLAVORS["acceptance"]
    flavor_cn, flavor_en = fl["cn"], fl["en"]
    accent, accent_soft, byline = fl["accent"], fl["accent_soft"], fl["byline"]
    section_label = fl["section_label"]
    report_version = (report_version or "v0.9").strip()
    if not re.fullmatch(r"v\d+\.\d+", report_version):
        raise RuntimeError(f"报告版本号格式非法：{report_version!r}，应为 v<主版本>.<次版本>")
    manifest_errors = _manifest_figure_errors(manifest)
    if manifest_errors:
        raise RuntimeError("交互报告证据关系门禁未通过：\n- " + "\n- ".join(manifest_errors))
    figure_srcs = dict(figure_srcs or _figure_src_map(markdown_content))
    problem_items = _collect_problem_items(markdown_content, manifest)
    problem_anchors = {
        it["anchor"]: it["severity"]
        for it in problem_items
        if it.get("anchor")
    }
    body_html = _decorate_problem_figures(markdown_to_html(markdown_content), problem_anchors)
    body_html = _wrap_body_figures(body_html, manifest, figure_srcs)
    section_navigation = _collect_section_navigation(markdown_content, problem_items)
    verdict_cn, verdict_class = {
        "pass": ("通过", "pass"),
        "conditional": ("有条件通过", "conditional"),
        "fail": ("不通过", "fail"),
    }.get(verdict, (verdict, "unknown"))
    row_fail_count = sum(1 for it in problem_items if it.get("severity") == "P0")
    row_risk_count = sum(1 for it in problem_items if it.get("severity") in {"P1", "P2"})
    row_gap_count = _coverage_gap_count(markdown_content)
    report_time = _extract_report_time(markdown_content)
    report_time_html = (
        f'<time class="dl-item">报告时间 · {html.escape(report_time)}</time>' if report_time else ""
    )
    table_count = len(re.findall(r"^\|.+\|$", markdown_content, re.M))
    figures = []
    gallery_cards = []
    for shot in manifest:
        key = _figure_key(shot.get("name"))
        anchor = _figure_anchor(key)
        if not anchor:
            continue
        num = _figure_number(shot.get("name")) or key
        label = f"图{num.upper()}"
        cap = html.escape(shot.get("caption") or shot.get("name") or label)
        raw_src = figure_srcs.get(anchor, "")
        if not raw_src:
            raise RuntimeError(f"交互报告证据关系门禁未通过：{anchor} 缺少最终图片地址")
        src = html.escape(raw_src, quote=True)
        thumb = f'<img src="{src}" alt="{cap}" loading="eager" decoding="async"/>'
        nav_thumb = f'<img class="nav-thumb" src="{src}" alt="{cap}" loading="eager" decoding="async"/>'
        warnings = " ".join(str(w) for w in (shot.get("warnings") or []))
        severity = problem_anchors.get(anchor) or _severity_from_text(warnings)
        status_class = _severity_class(severity)
        nav_class = f' class="is-{status_class}"' if status_class else ""
        card_class = f"evidence-card is-{status_class}" if status_class else "evidence-card"
        badge = f'<em class="card-badge {status_class}">{html.escape(severity)}</em>' if severity else ""
        figures.append(
            f'<a{nav_class} href="#{anchor}" title="{cap}">{nav_thumb}'
            f'<div class="nav-copy"><span>{label}</span><small>{cap}</small></div></a>'
        )
        gallery_cards.append(
            f'<a class="{card_class}" href="#{anchor}">{badge}'
            f'{thumb}<strong>{label}</strong><span>{cap}</span></a>'
        )
    directory_items = []
    indexed_sections = list(enumerate(section_navigation, start=1))
    severity_order = {"P0": 0, "P1": 1, "P2": 1, "P3": 2}
    indexed_sections.sort(
        key=lambda item: (
            severity_order.get(str(item[1].get("severity") or "").upper(), 3),
            item[0],
        )
    )
    for index, section in indexed_sections:
        status_class = _severity_class(section.get("severity") or "")
        item_class = f"section-nav-item is-{status_class}" if status_class else "section-nav-item"
        badges = section.get("badges") or []
        badge_text = "、".join(badges[:3])
        if len(badges) > 3:
            badge_text += f" 等{len(badges)}项"
        marker = (
            f'<em class="section-nav-badge {status_class}">{html.escape(badge_text)}</em>'
            if badge_text else ""
        )
        directory_items.append(
            f'<a class="{item_class}" href="#{html.escape(section["id"], quote=True)}">'
            f'<span><small>{index:02d}</small>{html.escape(section["title"])}</span>{marker}</a>'
        )
    directory_html = "".join(directory_items) or '<p class="section-nav-empty">正文没有二级目录</p>'
    # 指标条按语义上色：0 个阻断项是好消息（绿），有阻断项必须红，缺口用墨色弱化。
    summary_cards = [
        ("证据图", str(len(manifest)), "可点击跳转", "accent" if manifest else "gap"),
        ("P0 定位项", str(row_fail_count), "阻断证据", "fail" if row_fail_count else "pass"),
        ("P1-P2 风险", str(row_risk_count), "风险定位", "risk" if row_risk_count else "pass"),
        ("缺口", str(row_gap_count), "未覆盖与弱相关", "gap" if row_gap_count else "pass"),
        ("表格行", str(table_count), "原始审计数据", ""),
    ]
    summary_html = "".join(
        f'<div class="metric{(" is-" + tone) if tone else ""}">'
        f'<span>{html.escape(label)}</span><strong>{html.escape(value)}</strong>'
        f'<small>{html.escape(note)}</small></div>'
        for label, value, note, tone in summary_cards
    )
    problem_html = ""
    if problem_items or verdict in {"conditional", "fail"}:
        if problem_items:
            cards = []
            for item in problem_items[:8]:
                sev = html.escape(item.get("badge") or item.get("severity") or "")
                cls = _severity_class(item.get("severity") or "") or "gap"
                title_text = html.escape(item.get("title") or "未通过项")
                detail = html.escape(item.get("detail") or "明细见正文对应表格")
                if item.get("anchor"):
                    href = f' href="#{html.escape(item["anchor"], quote=True)}"'
                    link_label = "查看证据图"
                elif item.get("severity") == "P3":
                    href = ' href="#总缺口账本"'
                    link_label = "查看完整缺口账本"
                else:
                    href = ' href="#缺陷清单"'
                    link_label = "查看正文缺陷清单"
                cards.append(
                    f'<div class="problem-card is-{cls}">'
                    f'<strong><span>{sev}</span>{title_text}</strong>'
                    f'<p>{detail}</p>'
                    f'<a{href}>{link_label}</a>'
                    f'</div>'
                )
            cards_html = "".join(cards)
        else:
            fallback_class = "risk" if verdict == "conditional" else "fail"
            fallback_badge = "条件" if verdict == "conditional" else "P0/P1"
            cards_html = (
                f'<div class="problem-card is-{fallback_class}">'
                f'<strong><span>{fallback_badge}</span>请查看正文风险与缺口清单</strong>'
                f'<p>报告 Verdict 为{html.escape(verdict_cn)}，但未抽取到结构化重点项。</p>'
                f'<a href="#缺陷清单">查看缺陷清单</a></div>'
            )
        if verdict == "conditional":
            focus_kicker = "有条件通过重点"
            focus_title = "先看这里：风险证据和未覆盖项"
        else:
            focus_kicker = "不通过定位"
            focus_title = "先看这里：失败位置和证据"
        problem_html = (
            f'<section class="failure-focus is-{verdict_class}">'
            f'<div class="focus-kicker">{focus_kicker}</div>'
            f'<h2>{focus_title}</h2>'
            f'<div class="problem-grid">{cards_html}</div>'
            f'</section>'
        )
    evidence_count = len(manifest or [])
    gallery_html = "".join(gallery_cards) or (
        '<p class="empty-note">本报告未附截图证据。验收标准 v2 要求真人路径取证，'
        '出现这种形态说明取证环节被跳过，结论不可直接采信。</p>'
    )
    nav_html = "".join(figures) or '<p class="nav-empty">未附截图证据</p>'
    result = f"""<!doctype html>
<!-- map-acceptance-template: interactive-html-v2 -->
<html lang="zh-CN" data-template="map-acceptance-interactive-html-v2" data-skin="miduo-press-dossier">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="map-acceptance-template" content="interactive-html-v2"/>
<title>{html.escape(title)}</title>
<style>
:root{{color-scheme:light;
--paper:#f7f1e8;--paper-2:#fffdf8;--ink:#211d18;
--ink-2:rgba(33,29,24,.74);--ink-3:rgba(33,29,24,.48);
--line:rgba(33,29,24,.14);--line-2:rgba(33,29,24,.30);
--accent:{accent};--accent-soft:{accent_soft};
--pass:#1a7f37;--warn:#9a6700;--fail:#b42318;
--side:#211d18;--side-text:#f3ead9;--side-muted:rgba(243,234,217,.55);--side-line:rgba(243,234,217,.16);
--serif:"Source Serif 4","Songti SC","Noto Serif SC","STSong",Georgia,serif;
--sans:-apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Helvetica Neue",sans-serif;
--mono:"SF Mono","JetBrains Mono",Consolas,monospace}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.78 var(--sans);-webkit-font-smoothing:antialiased;
background-image:radial-gradient(ellipse 80% 40% at 50% -6%,{accent_soft},transparent),repeating-linear-gradient(0deg,rgba(33,29,24,.016) 0 1px,transparent 1px 3px)}}
.layout{{display:grid;grid-template-columns:minmax(232px,288px) minmax(0,1fr);min-height:100vh}}
aside{{position:sticky;top:0;height:100vh;overflow:auto;border-right:2px solid var(--ink);background:var(--side);color:var(--side-text);padding:18px}}
.side-mast{{display:flex;align-items:center;gap:10px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--side-line)}}
.side-mast .side-stamp{{width:34px;height:34px;flex-shrink:0;background:var(--accent);color:#fff7ee;border-radius:3px;display:grid;place-items:center;font-family:var(--serif);font-weight:700;font-size:12px;box-shadow:2px 2px 0 rgba(0,0,0,.5)}}
.side-mast b{{font-family:var(--serif);font-size:14.5px;font-weight:700;display:block;letter-spacing:.02em;color:var(--side-text)}}
.edition-version{{display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid currentColor;border-radius:2px;font-family:var(--mono);font-size:9px;font-weight:700;vertical-align:2px;letter-spacing:.04em}}
aside p{{color:var(--side-muted);margin:0;font-size:12.5px}}
.side-mast i{{font-style:normal;font-family:var(--mono);font-size:8.5px;letter-spacing:.22em;color:var(--side-muted);display:block;margin-top:2px}}
.side-verdict{{display:flex;align-items:baseline;gap:8px;margin:0 0 12px;padding:8px 10px;border:1px solid var(--side-line);border-left:4px solid var(--side-muted);border-radius:2px;background:rgba(255,255,255,.04)}}
.side-verdict b{{font-family:var(--serif);font-size:14px;color:#fff}}
.side-verdict small{{font-family:var(--mono);font-size:9px;letter-spacing:.16em;color:var(--side-muted)}}
.side-verdict.is-pass{{border-left-color:#4fb477}}
.side-verdict.is-conditional{{border-left-color:#d5a03f}}
.side-verdict.is-fail{{border-left-color:#e0604c}}
.nav-title{{font-family:var(--mono);font-size:10px;letter-spacing:.24em;color:var(--side-muted);margin:0 0 10px}}
.side-tabs{{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:0 0 12px;padding:3px;border:1px solid var(--side-line);border-radius:3px;background:rgba(0,0,0,.22)}}
.side-tab{{min-width:0;border:0;background:transparent;color:var(--side-muted);padding:8px 6px;text-align:left;box-shadow:none}}
.side-tab:hover{{background:rgba(255,255,255,.06);color:var(--side-text)}}
.side-tab.active{{background:var(--accent);color:#fff7ee}}
.side-tab span{{display:block;font-size:11px;font-weight:700;line-height:1.25}}
.side-tab small{{display:block;margin-top:2px;font-size:8px;letter-spacing:.12em;opacity:.72}}
.side-drawer-toggle{{display:none}}
.side-panel{{display:none}}
.side-panel.active{{display:block}}
.nav-empty{{color:var(--side-muted);font-size:12px}}
.evidence-nav{{display:flex;flex-direction:column;gap:8px;margin-bottom:18px}}
.evidence-nav a{{display:grid;grid-template-columns:76px minmax(0,1fr);gap:9px;align-items:start;text-decoration:none;color:var(--side-text);border:1px solid var(--side-line);background:rgba(255,255,255,.03);border-radius:3px;padding:7px;min-height:64px;transition:border-color .15s ease,background .15s ease}}
.evidence-nav a.is-fail{{border:2px solid #e0604c;background:rgba(180,35,24,.20);box-shadow:0 0 0 1px rgba(224,96,76,.25)}}
.evidence-nav a.is-risk{{border-color:#d5a03f;background:rgba(154,103,0,.16)}}
.evidence-nav a:hover{{border-color:rgba(243,234,217,.55);background:rgba(255,255,255,.08)}}
.evidence-nav a.is-current{{border-color:var(--accent);background:rgba(255,255,255,.10)}}
.evidence-nav .nav-thumb{{width:76px;aspect-ratio:16/9;object-fit:cover;border:1px solid var(--side-line);border-radius:2px;background:rgba(0,0,0,.35)}}
.nav-copy{{min-width:0}}
.evidence-nav span{{display:block;font-family:var(--mono);font-size:11px;font-weight:700;margin:0 0 3px;color:#fff}}
.evidence-nav small{{display:block;color:var(--side-muted);font-size:12px;line-height:1.4;margin-top:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}}
.section-nav{{display:flex;flex-direction:column;gap:5px;margin-bottom:18px}}
.section-nav-item{{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;text-decoration:none;color:var(--side-text);border:1px solid transparent;border-left:3px solid var(--side-line);border-radius:2px;padding:8px;background:rgba(255,255,255,.025)}}
.section-nav-item:hover{{border-color:rgba(243,234,217,.45)}}
.section-nav-item.is-current{{border-left-color:var(--accent);background:rgba(255,255,255,.10)}}
.section-nav-item.is-fail{{border:2px solid #e0604c;background:rgba(180,35,24,.20)}}
.section-nav-item.is-risk{{border-color:#d5a03f;border-left-width:4px;background:rgba(154,103,0,.18)}}
.section-nav-item.is-gap{{border-color:rgba(243,234,217,.28);border-left-width:4px;background:rgba(255,255,255,.06)}}
.section-nav-item>span{{min-width:0;font-size:12px;line-height:1.45}}
.section-nav-item>span small{{display:inline-block;margin-right:6px;color:var(--side-muted);font-family:var(--mono);font-size:9px}}
.section-nav-badge{{flex-shrink:0;max-width:78px;padding:2px 5px;border-radius:2px;background:var(--fail);color:#fff7ee;font-family:var(--mono);font-size:9px;font-style:normal;line-height:1.35;text-align:center}}
.section-nav-badge.risk{{background:var(--warn)}}
.section-nav-badge.gap{{background:rgba(243,234,217,.30);color:var(--side-text)}}
.section-nav-empty{{color:var(--side-muted);font-size:12px}}
main{{min-width:0;width:100%;max-width:1520px;margin:0 auto;padding:0 clamp(18px,3vw,40px) 0}}
.hero{{padding:26px 0 0}}
.masthead{{display:flex;align-items:center;gap:14px;padding-bottom:12px;border-bottom:3px solid var(--ink);position:relative}}
.masthead::after{{content:"";position:absolute;left:0;right:0;bottom:-6px;height:1px;background:var(--ink)}}
.masthead .stamp{{width:44px;height:44px;flex-shrink:0;background:var(--accent);color:#fff7ee;border-radius:3px;display:grid;place-items:center;font-family:var(--serif);font-weight:700;font-size:14px;box-shadow:3px 3px 0 rgba(33,29,24,.82)}}
.masthead .t b{{font-family:var(--serif);font-size:clamp(19px,2.2vw,24px);font-weight:700;display:block;letter-spacing:.02em}}
.masthead .t span{{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);letter-spacing:.3em}}
.masthead .r{{margin-left:auto;text-align:right;font-family:var(--mono);font-size:10px;color:var(--ink-3);letter-spacing:.12em;line-height:1.8}}
.masthead .r span{{display:block}}
.dateline{{display:flex;flex-wrap:wrap;align-items:center;gap:0 18px;margin:14px 0 0;padding:7px 0;border-bottom:1px solid var(--line-2);font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;color:var(--ink-3)}}
.dl-item{{font-style:normal;white-space:nowrap}}
.dateline time{{color:var(--ink-2);font-weight:600}}
.dl-verdict{{margin-left:auto;padding:2px 8px;border:1px solid currentColor;border-radius:2px;font-weight:700;letter-spacing:.12em}}
.dl-verdict.pass{{color:var(--pass)}}.dl-verdict.conditional{{color:var(--warn)}}.dl-verdict.fail{{color:var(--fail)}}
.title-row{{display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;margin:22px 0 4px}}
.title{{margin:0;font-family:var(--serif);font-size:clamp(23px,3.1vw,33px);line-height:1.4;font-weight:650;flex:1;min-width:min(100%,300px);text-wrap:balance}}
.badge{{flex-shrink:0;align-self:flex-start;display:inline-flex;flex-direction:column;align-items:center;gap:2px;padding:10px 18px;border:2.5px solid currentColor;border-radius:4px;background:var(--paper-2);color:var(--ink-3);font-family:var(--serif);font-weight:700;font-size:17px;letter-spacing:.18em;transform:rotate(-4deg);box-shadow:3px 3px 0 rgba(33,29,24,.16);position:relative;margin-top:6px}}
.badge::after{{content:"";position:absolute;inset:3px;border:1px solid currentColor;border-radius:2px;opacity:.55}}
.badge i{{font-style:normal;font-family:var(--mono);font-size:8px;letter-spacing:.3em;opacity:.75;font-weight:700}}
.badge.pass{{color:var(--pass)}}.badge.conditional{{color:var(--warn)}}.badge.fail{{color:var(--fail)}}
.metric-grid{{display:flex;flex-wrap:wrap;margin:22px 0 0;border:1.5px solid var(--ink);border-radius:3px;background:var(--paper-2);overflow:hidden;box-shadow:4px 4px 0 rgba(33,29,24,.10)}}
.metric{{flex:1 1 118px;padding:13px 8px 12px;text-align:center;border-right:1px solid var(--line);position:relative}}
.metric:last-child{{border-right:none}}
.metric span{{display:block;font-family:var(--mono);font-size:10px;letter-spacing:.08em;color:var(--ink-3)}}
.metric strong{{display:block;font-family:var(--serif);font-size:30px;line-height:1.1;margin:5px 0 3px;color:var(--ink)}}
.metric small{{display:block;font-size:10.5px;color:var(--ink-3)}}
.metric.is-accent strong{{color:var(--accent)}}
.metric.is-pass strong{{color:var(--pass)}}
.metric.is-risk strong{{color:var(--warn)}}
.metric.is-fail strong{{color:var(--fail)}}
.metric.is-fail::before,.metric.is-risk::before{{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--fail)}}
.metric.is-risk::before{{background:var(--warn)}}
.failure-focus{{margin:24px 0 18px;border:1.5px solid var(--fail);border-radius:3px;background:var(--paper-2);box-shadow:6px 6px 0 rgba(180,35,24,.14);padding:16px 18px}}
.failure-focus.is-conditional{{border-color:var(--warn);background:rgba(154,103,0,.045);box-shadow:6px 6px 0 rgba(154,103,0,.16)}}
.focus-kicker{{font-family:var(--mono);font-size:10.5px;letter-spacing:.22em;color:var(--fail);font-weight:600}}
.failure-focus.is-conditional .focus-kicker{{color:var(--warn)}}
.failure-focus h2{{margin:6px 0 12px;padding:0;border:none;font-family:var(--serif);font-size:21px;color:var(--ink)}}
.problem-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(268px,1fr));gap:12px}}
.problem-card{{position:relative;border:1px solid var(--line-2);border-left:5px solid var(--ink-3);border-radius:3px;background:var(--paper-2);padding:12px 13px;box-shadow:2px 2px 0 rgba(33,29,24,.07)}}
.problem-card.is-fail{{border-left-color:var(--fail);background:rgba(180,35,24,.05)}}
.problem-card.is-risk{{border-left-color:var(--warn);background:rgba(154,103,0,.06)}}
.problem-card.is-gap{{border-left-color:var(--ink-3);background:rgba(33,29,24,.04)}}
.problem-card strong{{display:block;font-size:14.5px;line-height:1.5;color:var(--ink)}}
.problem-card strong span{{display:inline-block;margin-right:7px;padding:2px 7px;border-radius:2px;background:var(--fail);color:#fff7ee;font-family:var(--mono);font-size:11px;font-weight:700;box-shadow:2px 2px 0 rgba(33,29,24,.22)}}
.problem-card.is-risk strong span{{background:var(--warn)}}
.problem-card.is-gap strong span{{background:var(--ink-3)}}
.problem-card p{{border:0;box-shadow:none;background:transparent;margin:8px 0 9px;padding:0;color:var(--ink-2);font-size:13px;line-height:1.6;max-width:none}}
.problem-card a{{font-family:var(--mono);font-size:11.5px;font-weight:700;text-decoration:none;border-bottom:1px solid currentColor;padding-bottom:1px}}
.method-note{{margin:14px 0 0;border:1px solid var(--line-2);border-left:4px solid var(--accent);border-radius:3px;background:var(--accent-soft);color:var(--ink-2);padding:10px 12px;font-size:13px;line-height:1.6}}
.method-note strong{{color:var(--ink)}}
.method-note a{{font-weight:700;text-decoration:none}}
.method-note span{{color:var(--ink-3)}}
.toolbar{{position:sticky;top:0;z-index:14;background:var(--paper-2);border:1.5px solid var(--ink);border-radius:3px;padding:9px 10px;margin:20px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;box-shadow:4px 4px 0 rgba(33,29,24,.10)}}
.toolbar input{{min-width:200px;flex:1;border:1px solid var(--line-2);border-radius:2px;padding:8px 10px;font:inherit;background:#fff;color:var(--ink)}}
.filter-count{{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);letter-spacing:.06em;margin-left:auto;white-space:nowrap}}
button{{border:1px solid var(--ink);background:var(--paper-2);border-radius:2px;padding:7px 12px;font-family:var(--mono);font-size:12px;color:var(--ink-2);cursor:pointer;transition:background .16s ease,border-color .16s ease,color .16s ease}}
button:hover{{background:var(--ink);color:var(--paper)}}
button.active{{background:var(--accent);border-color:var(--accent);color:#fff7ee;font-weight:700}}
button:focus-visible,input:focus-visible,a:focus-visible{{outline:2px solid var(--accent);outline-offset:2px}}
.gallery-head{{margin:26px 0 0;padding-bottom:10px;border-bottom:2px solid var(--ink);display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}}
.gallery-kicker{{display:block;font-family:var(--mono);font-size:10px;letter-spacing:.24em;color:var(--accent);font-weight:600;width:100%}}
.gallery-title{{font-family:var(--serif);font-size:19px;font-weight:700;margin:0}}
.gallery-hint{{font-size:12px;color:var(--ink-3);margin-left:auto}}
#evidence-gallery{{scroll-margin-top:82px}}
.evidence-gallery{{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:16px;margin:18px 0 24px}}
.evidence-card{{position:relative;display:block;text-decoration:none;color:var(--ink);background:var(--paper-2);border:1.5px solid var(--ink);border-radius:3px;overflow:hidden;box-shadow:5px 5px 0 rgba(33,29,24,.12);transition:transform .15s ease,box-shadow .15s ease}}
.evidence-card:hover{{transform:translate(-2px,-2px);box-shadow:7px 7px 0 rgba(33,29,24,.18)}}
.evidence-card.is-hidden{{display:none}}
.evidence-card.is-fail{{border-color:var(--fail);box-shadow:5px 5px 0 rgba(180,35,24,.28)}}
.evidence-card.is-risk{{border-color:var(--warn);box-shadow:5px 5px 0 rgba(154,103,0,.24)}}
.evidence-card img,.thumb-placeholder{{width:100%;aspect-ratio:16/9;object-fit:cover;object-position:top center;border:0;border-radius:0;border-bottom:1.5px solid var(--ink);background:rgba(33,29,24,.05)}}
.thumb-placeholder{{display:grid;place-items:center;color:var(--ink-3);font-size:13px}}
.card-badge{{position:absolute;top:8px;left:8px;z-index:2;padding:2px 8px;border-radius:2px;background:var(--fail);color:#fff7ee;font-style:normal;font-family:var(--mono);font-size:11px;font-weight:700;box-shadow:2px 2px 0 rgba(33,29,24,.4)}}
.card-badge.risk{{background:var(--warn)}}
.card-badge.gap{{background:var(--ink-3)}}
.evidence-card strong,.evidence-card span{{display:block;padding:0 11px}}
.evidence-card strong{{padding-top:10px;font-family:var(--mono);font-size:11.5px;color:var(--accent)}}
.evidence-card span{{font-size:12.5px;color:var(--ink-2);line-height:1.5;padding-top:3px;padding-bottom:11px}}
.empty-note{{border:1px dashed var(--line-2);border-radius:3px;background:var(--paper-2);padding:14px 16px;color:var(--ink-3);font-size:13px;max-width:none}}
#reportBody{{display:block;counter-reset:sec}}
#reportBody>h1{{display:none}}
h1,h2,h3{{scroll-margin-top:82px}}
#reportBody h2{{font-family:var(--serif);font-size:21px;font-weight:700;line-height:1.4;margin:38px 0 14px;padding:0 0 10px;border-bottom:2px solid var(--ink);color:var(--ink)}}
#reportBody h2::before{{counter-increment:sec;content:"{section_label} " counter(sec,decimal-leading-zero);display:block;margin-bottom:5px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.24em;color:var(--accent)}}
#reportBody h3{{font-family:var(--serif);font-size:17px;font-weight:700;margin:22px 0 8px}}
p,ul,ol{{background:transparent;border:0;box-shadow:none;margin:0 0 13px;padding:0;font-size:14.5px;line-height:1.95;color:var(--ink-2)}}
#reportBody>p,#reportBody>ul,#reportBody>ol,#reportBody>blockquote{{max-width:76ch}}
ul,ol{{padding-left:1.5em}}
li{{margin:3px 0}}
b,strong{{color:var(--ink)}}
blockquote{{margin:0 0 13px;padding:11px 15px;border:0;border-left:3px solid var(--accent);border-radius:0 3px 3px 0;background:var(--accent-soft);color:var(--ink-2);box-shadow:none}}
a{{color:var(--accent)}}
code{{background:rgba(33,29,24,.07);border:1px solid var(--line);border-radius:2px;padding:1px 5px;font-family:var(--mono);font-size:.9em}}
pre{{margin:0 0 13px;padding:12px 14px;background:#241f19;color:#efe6d8;border:1px solid var(--ink);border-radius:3px;overflow:auto;box-shadow:3px 3px 0 rgba(33,29,24,.12);font-size:12.5px;line-height:1.7}}
pre code{{background:transparent;border:0;padding:0;color:inherit}}
.table-wrap{{overflow-x:auto;margin:0 0 18px;border:1.5px solid var(--ink);border-radius:3px;background:var(--paper-2);box-shadow:4px 4px 0 rgba(33,29,24,.08)}}
table{{border-collapse:collapse;width:100%;font-size:13.5px;background:transparent}}
th{{background:var(--ink);color:#f3ead9;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;font-weight:600;padding:10px 12px;text-align:left;white-space:nowrap}}
td{{border-bottom:1px dotted var(--line);padding:10px 12px;text-align:left;vertical-align:top;color:var(--ink-2)}}
tr:last-child td{{border-bottom:0}}
tbody tr:hover td{{background:rgba(33,29,24,.03)}}
tr.row-fail td{{background:rgba(180,35,24,.06)}}
tr.row-risk td{{background:rgba(154,103,0,.07)}}
tr.row-gap td{{background:rgba(33,29,24,.04);color:var(--ink-3)}}
tr.is-hidden{{display:none}}
tr.filter-empty-row{{display:none}}
tr.filter-empty-row td{{background:rgba(33,29,24,.035);color:var(--ink-3);font-style:italic}}
.table-wrap.has-filter-empty tr.filter-empty-row{{display:table-row}}
figure{{margin:18px 0 28px}}
.shot{{margin:16px 0 30px;border:1.5px solid var(--ink);border-radius:3px;background:var(--paper-2);box-shadow:6px 6px 0 rgba(33,29,24,.12);overflow:hidden}}
.shot.is-fail{{border-color:var(--fail);box-shadow:6px 6px 0 rgba(180,35,24,.22)}}
.shot.is-risk{{border-color:var(--warn);box-shadow:6px 6px 0 rgba(154,103,0,.20)}}
.shot-head{{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;background:var(--ink);color:#f3ead9;border-bottom:1.5px solid var(--ink)}}
.shot.is-fail .shot-head{{background:var(--fail)}}
.shot.is-risk .shot-head{{background:var(--warn)}}
.shot-no{{flex-shrink:0;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.12em;color:#fff;padding:2px 8px;border:1px solid rgba(255,255,255,.42);border-radius:2px}}
.shot-cap{{min-width:0;flex:1;font-size:13px;line-height:1.5;color:#f3ead9}}
.shot-zoom{{flex-shrink:0;font-family:var(--mono);font-size:11px;font-weight:700;color:#fff;text-decoration:none;border:1px solid rgba(255,255,255,.5);border-radius:2px;padding:3px 9px}}
.shot-zoom:hover{{background:rgba(255,255,255,.16)}}
.shot-frame{{display:flex;justify-content:center;padding:14px;background:repeating-linear-gradient(135deg,rgba(33,29,24,.045) 0 8px,rgba(33,29,24,.02) 8px 16px)}}
.shot-frame p{{margin:0;max-width:none}}
.shot-frame img{{display:block;margin:0 auto;max-width:100%;max-height:min(76vh,780px);width:auto;height:auto;border:1px solid var(--line-2);border-radius:2px;box-shadow:4px 4px 0 rgba(33,29,24,.14);cursor:zoom-in;background:#fff}}
.shot-foot{{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px dotted var(--line-2);background:var(--paper-2)}}
img{{max-width:100%;height:auto;border:1.5px solid var(--ink);border-radius:3px;display:block;box-shadow:4px 4px 0 rgba(33,29,24,.10)}}
figcaption{{color:var(--ink-3);font-size:12.5px;margin-top:8px;line-height:1.7}}
.shot figcaption{{color:inherit;font-size:inherit;margin-top:0}}
.figure-problem-banner{{flex-shrink:0;display:inline-block;padding:2px 9px;border:1px solid rgba(255,255,255,.7);border-radius:2px;background:rgba(0,0,0,.28);color:#fff;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.06em}}
.figure-back-link{{display:inline-flex;align-items:center;color:var(--accent);font-family:var(--mono);font-size:11.5px;font-weight:700;text-decoration:none}}
.figure-back-link::before{{content:"";display:inline-block;width:14px;height:1px;background:currentColor;margin-right:7px}}
.figure-back-link:hover{{color:var(--ink)}}
.section-toggle{{float:right;font-size:10.5px;padding:2px 8px;border-color:var(--line-2);color:var(--ink-3);background:transparent;box-shadow:none}}
.figure-anchor{{display:block;scroll-margin-top:96px;height:1px}}
.colophon{{margin:44px 0 0;padding:18px 0 40px;border-top:3px solid var(--ink);text-align:center;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;color:var(--ink-3);line-height:2}}
.colophon::before{{content:"";display:block;height:1px;background:var(--ink);margin:-14px 0 14px}}
.colophon b{{color:var(--ink);font-family:var(--serif);letter-spacing:.04em}}
.colophon p{{margin:0;font-size:10.5px;color:var(--ink-3);max-width:none}}
.to-top{{position:fixed;right:20px;bottom:20px;z-index:120;display:none;align-items:center;background:var(--ink);color:var(--paper);border-color:var(--ink);box-shadow:3px 3px 0 rgba(33,29,24,.30)}}
.to-top:hover{{background:var(--accent);border-color:var(--accent);color:#fff7ee}}
.to-top.is-on{{display:inline-flex}}
.lightbox{{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:18px}}
.lightbox[hidden]{{display:none}}
.lb-backdrop{{position:absolute;inset:0;background:rgba(20,17,13,.86);border:0}}
.lb-frame{{position:relative;display:flex;flex-direction:column;min-height:0;width:min(1280px,96vw);margin:0;border:2px solid var(--ink);border-radius:3px;background:var(--paper-2);box-shadow:8px 8px 0 rgba(0,0,0,.45);overflow:hidden}}
.lb-bar{{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0;margin:0;padding:9px 12px;background:var(--ink);color:#f3ead9}}
.lb-no{{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.12em;padding:2px 8px;border:1px solid rgba(255,255,255,.42);border-radius:2px;color:#fff}}
.lb-cap{{min-width:0;flex:1;color:#f3ead9;font-size:13px;font-weight:400;line-height:1.5}}
.lb-count{{font-family:var(--mono);font-size:10.5px;color:rgba(243,234,217,.66);letter-spacing:.1em}}
.lb-bar button{{background:transparent;color:#f3ead9;border-color:rgba(243,234,217,.42);padding:4px 10px}}
.lb-bar button:hover{{background:#f3ead9;color:var(--ink)}}
.lb-stage{{min-height:0;flex:1;display:flex;align-items:center;justify-content:center;padding:16px;background:repeating-linear-gradient(135deg,rgba(33,29,24,.06) 0 8px,rgba(33,29,24,.02) 8px 16px);overflow:auto;overscroll-behavior:contain}}
.lb-stage img{{max-width:100%;max-height:100%;width:auto;height:auto;border:1px solid var(--line-2);border-radius:2px;box-shadow:4px 4px 0 rgba(33,29,24,.22);background:#fff}}
:target{{outline:3px solid var(--accent);outline-offset:3px;border-radius:3px}}
@media(prefers-reduced-motion:reduce){{*{{scroll-behavior:auto!important;transition:none!important}}}}
@media(max-width:980px){{
.layout{{display:block}}
aside{{position:sticky;top:0;z-index:20;height:auto;max-height:214px;padding:12px 16px;border-right:0;border-bottom:2px solid var(--ink);box-shadow:0 6px 18px rgba(33,29,24,.16)}}
.side-mast{{margin-bottom:8px}}
.side-verdict{{margin-bottom:8px;padding:6px 9px}}
.side-tabs{{margin-bottom:8px}}
.side-panel{{max-height:116px;overflow:auto}}
.evidence-nav small{{-webkit-line-clamp:2}}
.evidence-nav{{flex-direction:row;overflow-x:auto;padding-bottom:6px;-webkit-overflow-scrolling:touch}}
.evidence-nav a{{flex:0 0 210px}}
.section-nav{{display:flex;gap:7px;overflow-x:auto;padding-bottom:6px;-webkit-overflow-scrolling:touch}}
.section-nav-item{{flex:0 0 220px;margin:0}}
main{{padding:0 16px 0}}
.hero{{padding-top:18px}}
.metric{{flex:1 1 32%;border-bottom:1px solid var(--line)}}
.toolbar{{position:static}}
.figure-anchor,#evidence-gallery,h1,h2,h3{{scroll-margin-top:226px}}
}}
@media(max-width:640px){{
html,body{{overflow-x:clip}}
aside{{max-height:none;padding:8px 10px;overflow:visible}}
.side-mast{{gap:8px;padding-bottom:6px;margin-bottom:6px}}
.side-mast .side-stamp{{width:28px;height:28px;font-size:10px}}
.side-mast b{{font-size:12.5px}}
.side-mast i{{display:none}}
.side-verdict{{display:none}}
.side-controls{{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:stretch}}
.side-tabs{{margin:0}}
.side-tab{{padding:6px 7px}}
.side-tab span{{font-size:10.5px}}
.side-drawer-toggle{{display:flex;align-items:center;justify-content:center;min-width:68px;border-color:var(--side-line);background:rgba(255,255,255,.04);color:var(--side-text);padding:5px 8px}}
.side-drawer-toggle:hover{{background:rgba(255,255,255,.10);color:var(--side-text)}}
.side-drawer-toggle[aria-expanded="true"]{{border-color:var(--accent);background:var(--accent);color:#fff7ee}}
.side-drawer{{display:none;max-height:min(52vh,420px);overflow-y:auto;overscroll-behavior:contain;margin-top:8px;padding:8px 2px 2px;border-top:1px solid var(--side-line);-webkit-overflow-scrolling:touch}}
aside.mobile-nav-open .side-drawer{{display:block}}
.side-panel{{max-height:none;overflow:visible}}
.evidence-nav,.section-nav{{display:flex;flex-direction:column;gap:6px;overflow:visible;padding:0;margin:0}}
.evidence-nav a,.section-nav-item{{flex:none;width:100%;margin:0}}
.evidence-nav a{{grid-template-columns:68px minmax(0,1fr);min-height:58px}}
.figure-anchor,#evidence-gallery,h1,h2,h3{{scroll-margin-top:118px}}
.masthead .r{{display:none}}
.masthead .stamp{{width:36px;height:36px;font-size:12px}}
.dateline{{gap:0 12px;font-size:9.5px}}
.dl-verdict{{margin-left:0}}
.title-row{{gap:12px}}
.badge{{font-size:14px;padding:8px 13px}}
.metric{{flex:1 1 48%}}
.metric strong{{font-size:25px}}
.evidence-gallery{{grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}}
.shot-frame{{padding:9px}}
.shot-frame img{{max-height:none}}
.filter-count{{margin-left:0;width:100%}}
.to-top{{right:12px;bottom:12px}}
.lightbox{{padding:8px}}
.lb-frame{{width:100%}}
}}
</style>
</head>
<body>
<div class="layout">
<aside id="report-navigation">
  <div class="side-mast"><span class="side-stamp">MAP</span><div><b>{flavor_cn}<small class="edition-version">{html.escape(report_version)}</small></b><i>{flavor_en}</i></div></div>
  <div class="side-verdict is-{verdict_class}"><b>{html.escape(verdict_cn)}</b><small>VERDICT · 证据 {evidence_count}</small></div>
  <div class="side-controls">
    <div class="side-tabs" role="tablist" aria-label="报告导航">
      <button class="side-tab active" type="button" role="tab" aria-selected="true" aria-controls="side-panel-evidence" data-side-tab="evidence"><span>证据导航</span><small>EVIDENCE</small></button>
      <button class="side-tab" type="button" role="tab" aria-selected="false" aria-controls="side-panel-contents" data-side-tab="contents"><span>报告目录</span><small>CONTENTS</small></button>
    </div>
    <button class="side-drawer-toggle" type="button" aria-expanded="false" aria-controls="mobile-nav-drawer" data-mobile-nav-toggle>展开导航</button>
  </div>
  <div id="mobile-nav-drawer" class="side-drawer" aria-hidden="false">
    <div id="side-panel-evidence" class="side-panel active" role="tabpanel"><div class="evidence-nav">{nav_html}</div></div>
    <div id="side-panel-contents" class="side-panel" role="tabpanel"><nav class="section-nav" aria-label="报告目录">{directory_html}</nav></div>
  </div>
</aside>
<main>
  <header class="hero">
    <div class="masthead">
      <div class="stamp">MAP</div>
      <div class="t"><b>{flavor_cn}<small class="edition-version">{html.escape(report_version)}</small></b><span>{flavor_en}</span></div>
      <div class="r"><span>MAP 验收标准 v2 · 真人路径取证</span><span>{byline}</span></div>
    </div>
    <div class="dateline">
      <i class="dl-item">{flavor_en}</i>
      <i class="dl-item">证据 {evidence_count} 张</i>
      <i class="dl-item">表格 {table_count} 行</i>
      {report_time_html}
      <i class="dl-verdict {verdict_class}">判定 · {html.escape(verdict_cn)}</i>
    </div>
    <div class="title-row"><h1 class="title">{html.escape(title)}</h1><span class="badge {verdict_class}"><i>VERDICT</i>{html.escape(verdict_cn)}</span></div>
    <div class="metric-grid">{summary_html}</div>
  </header>
  {problem_html}
  <div class="toolbar">
    <input id="reportFilter" placeholder="筛选表格、缺陷、模块或图号"/>
    <button data-filter="all" class="active">全部</button>
    <button data-filter="fail">未通过/P0</button>
    <button data-filter="risk">有缺陷/P1</button>
    <button data-filter="gap">未覆盖</button>
    <span class="filter-count" id="filterCount"></span>
  </div>
  <section id="evidence-gallery" class="evidence-gallery-wrap"><div class="gallery-head"><span class="gallery-kicker">证据版面 · EVIDENCE PLATES</span><div class="gallery-title">证据缩略图</div><span class="gallery-hint">点缩略图跳到正文对应位置，点正文图片可放大查看</span></div><div class="evidence-gallery">{gallery_html}</div></section>
  <article id="reportBody">{body_html}</article>
  <footer class="colophon">
    <p><b>{flavor_cn}</b> · {flavor_en} · {html.escape(report_version)}</p>
    <p>{byline} · 证据 {evidence_count} 张 · 表格 {table_count} 行 · 判定 {html.escape(verdict_cn)}</p>
    <p>MIDUO PRESS · 归档于 CDS 验收中心 · 证据链与结论一一对应</p>
  </footer>
</main>
</div>
<button class="to-top" type="button" data-to-top>回到顶部</button>
<div class="lightbox" id="evidence-lightbox" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-label="证据大图">
  <button class="lb-backdrop" type="button" data-lb-close aria-label="关闭大图"></button>
  <figure class="lb-frame" style="max-height:94vh">
    <figcaption class="lb-bar">
      <span class="lb-no" data-lb-no></span>
      <b class="lb-cap" data-lb-cap></b>
      <span class="lb-count" data-lb-count></span>
      <button type="button" data-lb-prev>上一张</button>
      <button type="button" data-lb-next>下一张</button>
      <button type="button" data-lb-close>关闭</button>
    </figcaption>
    <div class="lb-stage"><img data-lb-image alt=""/></div>
  </figure>
</div>
<script>
(function(){{
  var reportNavigation=document.getElementById('report-navigation');
  var mobileNavDrawer=document.getElementById('mobile-nav-drawer');
  var mobileNavToggle=document.querySelector('[data-mobile-nav-toggle]');
  var mobileNavQuery=window.matchMedia('(max-width:640px)');
  function isMobileNavigation(){{return mobileNavQuery.matches;}}
  function setMobileNavOpen(open){{
    var expanded=isMobileNavigation()&&Boolean(open);
    reportNavigation.classList.toggle('mobile-nav-open',expanded);
    mobileNavToggle.setAttribute('aria-expanded',expanded?'true':'false');
    mobileNavToggle.textContent=expanded?'收起导航':'展开导航';
    mobileNavDrawer.setAttribute('aria-hidden',isMobileNavigation()&&!expanded?'true':'false');
  }}
  function setSideTab(name){{
    document.querySelectorAll('[data-side-tab]').forEach(function(tab){{
      var active=tab.getAttribute('data-side-tab')===name;
      tab.classList.toggle('active',active);
      tab.setAttribute('aria-selected',active?'true':'false');
    }});
    document.querySelectorAll('.side-panel').forEach(function(panel){{
      panel.classList.toggle('active',panel.id==='side-panel-'+name);
    }});
  }}
  document.querySelectorAll('[data-side-tab]').forEach(function(tab){{
    tab.addEventListener('click',function(){{
      setSideTab(tab.getAttribute('data-side-tab'));
      if(isMobileNavigation()) setMobileNavOpen(true);
    }});
  }});
  mobileNavToggle.addEventListener('click',function(){{
    setMobileNavOpen(mobileNavToggle.getAttribute('aria-expanded')!=='true');
  }});
  function syncMobileNavigation(){{
    if(isMobileNavigation()) setMobileNavOpen(false);
    else{{
      reportNavigation.classList.remove('mobile-nav-open');
      mobileNavToggle.setAttribute('aria-expanded','false');
      mobileNavToggle.textContent='展开导航';
      mobileNavDrawer.setAttribute('aria-hidden','false');
    }}
  }}
  if(mobileNavQuery.addEventListener) mobileNavQuery.addEventListener('change',syncMobileNavigation);
  else if(mobileNavQuery.addListener) mobileNavQuery.addListener(syncMobileNavigation);
  syncMobileNavigation();
  var filterInput=document.getElementById('reportFilter');
  var filterCount=document.getElementById('filterCount');
  var mode='all';
  function applyFilter(){{
    var q=(filterInput.value||'').toLowerCase();
    var totalRows=0,visibleRows=0;
    document.querySelectorAll('tbody tr').forEach(function(row){{
      if(row.classList.contains('filter-empty-row')) return;
      totalRows+=1;
      var text=row.textContent.toLowerCase();
      var modeOk=mode==='all'||(mode==='fail'&&/\\bp0\\b|未通过|\\bfail\\b|阻断/i.test(text))||(mode==='risk'&&/p1|有缺陷|conditional|风险/i.test(text))||(mode==='gap'&&/未覆盖|not-run|未深测|弱相关|无关/i.test(text));
      var queryOk=!q||text.indexOf(q)>=0;
      var show=modeOk&&queryOk;
      if(show) visibleRows+=1;
      row.classList.toggle('is-hidden', !show);
    }});
    document.querySelectorAll('.table-wrap table').forEach(function(table){{
      var tbody=table.querySelector('tbody');
      if(!tbody) return;
      var empty=tbody.querySelector('.filter-empty-row');
      if(!empty){{
        empty=document.createElement('tr');
        empty.className='filter-empty-row';
        var td=document.createElement('td');
        td.colSpan=Math.max(1, table.querySelectorAll('thead th').length);
        td.textContent='当前筛选条件下无匹配行；请清空筛选或切回“全部”。';
        empty.appendChild(td);
        tbody.appendChild(empty);
      }}
      var visible=Array.prototype.some.call(tbody.querySelectorAll('tr:not(.filter-empty-row)'), function(row){{
        return !row.classList.contains('is-hidden');
      }});
      table.closest('.table-wrap').classList.toggle('has-filter-empty', !visible);
    }});
    var totalCards=0,visibleCards=0;
    document.querySelectorAll('.evidence-card').forEach(function(card){{
      totalCards+=1;
      var text=card.textContent.toLowerCase();
      var severityOk=mode==='fail'?card.classList.contains('is-fail')
        :mode==='risk'?card.classList.contains('is-risk'):true;
      var show=severityOk&&(!q||text.indexOf(q)>=0);
      if(show) visibleCards+=1;
      card.classList.toggle('is-hidden', !show);
    }});
    document.querySelectorAll('.problem-card').forEach(function(card){{
      var text=card.textContent.toLowerCase();
      var severityOk=mode==='fail'?card.classList.contains('is-fail')
        :mode==='risk'?card.classList.contains('is-risk')
        :mode==='gap'?card.classList.contains('is-gap'):true;
      card.classList.toggle('is-hidden', !(severityOk&&(!q||text.indexOf(q)>=0)));
    }});
    if(filterCount){{
      filterCount.textContent=(mode==='all'&&!q)
        ?('共 '+totalRows+' 行 · 证据 '+totalCards+' 张')
        :('命中 '+visibleRows+'/'+totalRows+' 行 · 证据 '+visibleCards+'/'+totalCards+' 张');
    }}
  }}
  filterInput.addEventListener('input', applyFilter);
  document.querySelectorAll('button[data-filter]').forEach(function(btn){{
    btn.addEventListener('click', function(){{
      mode=btn.getAttribute('data-filter');
      document.querySelectorAll('button[data-filter]').forEach(function(b){{b.classList.remove('active')}});
      btn.classList.add('active');
      applyFilter();
    }});
  }});
  applyFilter();
  function expandSectionForTarget(target){{
    if(!target) return;
    var h=target.previousElementSibling;
    while(h&&h.tagName!=='H2') h=h.previousElementSibling;
    if(!h||!h.classList.contains('collapsed')) return;
    h.classList.remove('collapsed');
    var btn=h.querySelector('.section-toggle');
    if(btn) btn.textContent='收起';
    var n=h.nextElementSibling;
    while(n&&n.tagName!=='H2'){{
      n.style.display='';
      n=n.nextElementSibling;
    }}
  }}
  function targetForHash(hash){{
    if(!hash||hash.charAt(0)!=='#') return null;
    var id=hash.slice(1);
    try{{id=decodeURIComponent(id);}}catch(error){{return null;}}
    return document.getElementById(id);
  }}
  document.querySelectorAll('#reportBody h2').forEach(function(h){{
    var b=document.createElement('button');
    b.className='section-toggle';
    b.type='button';
    b.textContent='收起';
    h.appendChild(b);
    b.addEventListener('click', function(ev){{
      ev.preventDefault();
      var collapsed=h.classList.toggle('collapsed');
      b.textContent=collapsed?'展开':'收起';
      var n=h.nextElementSibling;
      while(n&&n.tagName!=='H2'){{
        n.style.display=collapsed?'none':'';
        n=n.nextElementSibling;
      }}
    }});
  }});
  function jumpToTarget(hash){{
    var t=targetForHash(hash);
    if(!t) return;
    expandSectionForTarget(t);
    var scroll=function(){{
      t.scrollIntoView({{block:'start'}});
      try{{if(history&&history.replaceState) history.replaceState(null,'',hash);}}catch(error){{}}
    }};
    if(isMobileNavigation()){{
      setMobileNavOpen(false);
      requestAnimationFrame(function(){{requestAnimationFrame(scroll);}});
    }}else scroll();
  }}
  document.addEventListener('click', function(ev){{
    var a=ev.target.closest&&ev.target.closest('a[href^="#"]');
    if(!a) return;
    var hash=a.getAttribute('href');
    var t=targetForHash(hash);
    if(!t) return;
    ev.preventDefault();
    if(a.hasAttribute('data-return-evidence')) setSideTab('evidence');
    jumpToTarget(hash);
  }});
  window.addEventListener('hashchange', function(){{
    var t=targetForHash(location.hash);
    expandSectionForTarget(t);
  }});
  // 证据大图：正文图版点击即放大，禁用 JS 时「放大查看」退化为直接打开原图链接。
  var lightbox=document.getElementById('evidence-lightbox');
  var lbImage=lightbox.querySelector('[data-lb-image]');
  var lbNo=lightbox.querySelector('[data-lb-no]');
  var lbCap=lightbox.querySelector('[data-lb-cap]');
  var lbCount=lightbox.querySelector('[data-lb-count]');
  var plates=Array.prototype.slice.call(document.querySelectorAll('.shot[data-lb-src]'));
  var lbIndex=-1;
  var lastFocus=null;
  function renderLightbox(){{
    var plate=plates[lbIndex];
    if(!plate) return;
    lbImage.setAttribute('src',plate.getAttribute('data-lb-src')||'');
    lbImage.setAttribute('alt',plate.getAttribute('data-lb-cap')||'');
    lbNo.textContent=plate.getAttribute('data-lb-no')||'';
    lbCap.textContent=plate.getAttribute('data-lb-cap')||'';
    lbCount.textContent=(lbIndex+1)+' / '+plates.length;
  }}
  function openLightbox(index){{
    if(!plates.length) return;
    lbIndex=(index+plates.length)%plates.length;
    lastFocus=document.activeElement;
    renderLightbox();
    lightbox.hidden=false;
    lightbox.setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
    var close=lightbox.querySelector('[data-lb-next]');
    if(close&&close.focus) close.focus();
  }}
  function closeLightbox(){{
    lightbox.hidden=true;
    lightbox.setAttribute('aria-hidden','true');
    document.body.style.overflow='';
    if(lastFocus&&lastFocus.focus) lastFocus.focus();
  }}
  function stepLightbox(delta){{
    if(!plates.length) return;
    lbIndex=(lbIndex+delta+plates.length)%plates.length;
    renderLightbox();
  }}
  plates.forEach(function(plate,index){{
    var image=plate.querySelector('.shot-frame img');
    if(image) image.addEventListener('click',function(){{openLightbox(index);}});
    var zoom=plate.querySelector('.shot-zoom');
    if(zoom) zoom.addEventListener('click',function(ev){{ev.preventDefault();openLightbox(index);}});
  }});
  lightbox.querySelectorAll('[data-lb-close]').forEach(function(btn){{
    btn.addEventListener('click',closeLightbox);
  }});
  var prevBtn=lightbox.querySelector('[data-lb-prev]');
  var nextBtn=lightbox.querySelector('[data-lb-next]');
  if(prevBtn) prevBtn.addEventListener('click',function(){{stepLightbox(-1);}});
  if(nextBtn) nextBtn.addEventListener('click',function(){{stepLightbox(1);}});
  document.addEventListener('keydown',function(ev){{
    if(lightbox.hidden) return;
    if(ev.key==='Escape'){{ev.preventDefault();closeLightbox();}}
    else if(ev.key==='ArrowLeft') stepLightbox(-1);
    else if(ev.key==='ArrowRight') stepLightbox(1);
  }});
  // 回到顶部与「读到哪一段」高亮：长档案不必回侧栏找位置。
  var toTop=document.querySelector('[data-to-top]');
  var navLinks=Array.prototype.slice.call(document.querySelectorAll('.section-nav-item,.evidence-nav a'));
  function syncReadingState(){{
    if(toTop) toTop.classList.toggle('is-on',window.scrollY>560);
    var current='';
    document.querySelectorAll('#reportBody h2,.figure-anchor').forEach(function(node){{
      if(node.getBoundingClientRect().top<=140&&node.id) current=node.id;
    }});
    navLinks.forEach(function(link){{
      var href=link.getAttribute('href')||'';
      link.classList.toggle('is-current',current!==''&&href==='#'+current);
    }});
  }}
  if(toTop) toTop.addEventListener('click',function(){{window.scrollTo({{top:0,behavior:'smooth'}});}});
  window.addEventListener('scroll',syncReadingState,{{passive:true}});
  syncReadingState();
  if(location.hash){{setTimeout(function(){{jumpToTarget(location.hash);}},50);}}
}})();
</script>
</body>
</html>"""
    evidence_errors = _interactive_evidence_errors(result, manifest)
    if evidence_errors:
        raise RuntimeError("交互报告证据关系门禁未通过：\n- " + "\n- ".join(evidence_errors))
    return result


def _report_flavor(a, body):
    """报告刊头身份：每日验收 =「每日巡检特刊」，其余 =「MAP 验收档案」。

    直接复用门禁判定 _declares_daily_acceptance（每日措辞的唯一入口），
    皮肤与门禁不可能不一致——拿巡检刊头的报告必然也被要求满足每日门禁。
    """
    try:
        return "daily" if _declares_daily_acceptance(getattr(a, "target", "") or "", body or "") else "acceptance"
    except Exception:
        return "acceptance"


# ── CDS 验收中心（默认主路，职责分离：验收能力归 CDS，MAP 走开放协议消费）──
CDS_REPORT_CAP = 10 * 1024 * 1024  # 仅正文；截图通过 /api/reports/assets 独立上传


def _cds_base():
    host = os.environ.get("CDS_HOST", "").strip().rstrip("/")
    if not host:
        raise RuntimeError("CDS_HOST 未设置（export CDS_HOST=<cds-host>）")
    if not host.startswith("http"):
        host = "https://" + host
    return host


def _cds_auth_headers():
    """与 cdscli._auth_headers 一致：项目级 key 优先，否则全局 AI_ACCESS_KEY。"""
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


def _cds_upload_asset(path):
    """先上传单张截图，返回 CDS 内容寻址不可变 URL。正文不再携带 base64。"""
    suffix = Path(path).suffix.lower()
    content_type = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix)
    if not content_type:
        raise RuntimeError(f"CDS 截图只支持 PNG、JPEG 或 WebP：{path}")
    resp = curl(_cds_auth_headers() + [
        "-H", f"Content-Type: {content_type}",
        "-X", "POST",
        "--data-binary", f"@{path}",
        _cds_base() + "/api/reports/assets",
    ])
    asset = resp.get("asset") if isinstance(resp, dict) else None
    if not asset or not asset.get("url"):
        raise RuntimeError(f"CDS 截图上传失败：{json.dumps(resp, ensure_ascii=False)[:300]}")
    url = str(asset["url"])
    if url.startswith("/"):
        url = _cds_base() + url
    return url, asset


def _cds_resolve_project(cfg):
    """CDS 项目 ID：config.report.cdsProjectId > env CDS_PROJECT_ID > config.project（项目身份 slug）。
    解析不到时返回 None（归到 CDS 自身 / 全局，仍可入库）。"""
    rep = cfg.get("report", {})
    pid = (rep.get("cdsProjectId") or os.environ.get("CDS_PROJECT_ID") or cfg.get("project") or "").strip()
    return pid or None


def _resolve_folder_path(cfg, a):
    """文件夹归类三级解析：--folder-path > config.report.cdsFolder > --module 自动归类。
    报告必须归文件夹是默认行为（2026-07-10 用户反馈「54 份报告大半散在根上」）——
    三者都空才落项目根。返回 '/' 分隔路径字符串，交给服务端 POST /api/reports 的
    folderPath 在项目作用域内 find-or-create（原生支持嵌套，客户端不再解析 folderId）。"""
    explicit = (getattr(a, "folder_path", "") or "").strip()
    if explicit:
        return explicit
    configured = (cfg.get("report", {}).get("cdsFolder") or "").strip()
    if configured:
        return configured
    return (a.module or "").strip()


def run_cds(cfg, a, title, report_id, body, manifest, now, tags=None):
    """职责分离主路：把验收报告和独立截图资产入库到 CDS 验收中心。
    报告永远按项目归类；MAP 等系统通过知识库开放协议（peer-sync）从 CDS 拉取展示。"""
    project_id = _cds_resolve_project(cfg)
    folder_path = _resolve_folder_path(cfg, a)

    # 截图先入 CDS 内容寻址资产库；正文只保留不可变 HTTPS 地址。
    # 这样截图数量由证据需要决定，不再占用 10MB 文本正文额度。
    evid_parts, img_md, figure_srcs = [], {}, {}
    for m in manifest:
        uri, asset = _cds_upload_asset(m["path"])
        evid_parts.append(_with_figure_anchor(m["name"], f"**{m['caption']}**\n\n![{m['caption']}]({uri})"))
        img_md[m["name"]] = f"![{m['caption']}]({uri})"
        figure_srcs[_figure_anchor(_figure_key(m["name"]))] = uri
        print(f"  上传截图 {m['name']} ({asset.get('sizeBytes', os.path.getsize(m['path']))}B) -> {asset.get('name', uri)}")
    meta = build_meta(report_id, now, "cds", a, "")
    content_md = assemble(title, body, "\n\n".join(evid_parts), meta, img_md)
    fmt = report_format(cfg, "cds")
    content = build_interactive_html(
        title,
        a.verdict,
        content_md,
        manifest,
        flavor=_report_flavor(a, body),
        figure_srcs=figure_srcs,
        report_version=a.report_version,
    ) if fmt == "html" else content_md
    size = len(content.encode("utf-8"))
    if size > CDS_REPORT_CAP:
        raise RuntimeError(
            f"报告文本正文 {size/1048576:.1f}MB 超 CDS 10MB 上限。"
            "截图已独立存储，因此无需减少证据图；请拆分过长文字或日志附件后重跑。")

    payload = {
        "title": title, "format": fmt, "content": content,
        "projectId": project_id,
        "verdict": a.verdict, "tier": a.tier,
    }
    if folder_path:
        payload["folderPath"] = folder_path
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
    link_folder = rep.get("folderId")
    qs = []
    if link_project:
        qs.append(f"project={link_project}")
    if link_folder:
        qs.append(f"folder={link_folder}")
    qs.append(f"report={rid}")
    deeplink = f"{base}/reports?" + "&".join(qs)
    print(json.dumps({
        "mode": "cds", "title": title, "report_id": report_id, "cdsReportId": rid,
        "projectId": project_id, "folderId": link_folder, "folderPath": folder_path or None,
        "format": fmt, "verdict": a.verdict, "deeplink": deeplink,
    }, ensure_ascii=False))
    print("\n===== 验收归档完成 · CDS 验收中心 =====")
    print("直达深链（CDS 登录态可达，按项目+文件夹归类）：" + deeplink)
    print("说明：报告已入 CDS（验收能力的唯一归属）；MAP 等系统通过知识库开放协议从 CDS 拉取展示，无需另建验收知识库。")


def run_local(cfg, a, title, report_id, body, manifest, meta, tags=None):
    out_dir = cfg["report"].get("localOutDir") or LOCAL_DEFAULT_OUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    shot_dir = os.path.join(out_dir, report_id)
    os.makedirs(shot_dir, exist_ok=True)
    evid_parts, img_md, figure_srcs = [], {}, {}
    for m in manifest:
        dst = os.path.join(shot_dir, f"{m['name']}.png")
        shutil.copyfile(m["path"], dst)
        rel = f"./{report_id}/{m['name']}.png"
        evid_parts.append(_with_figure_anchor(m["name"], f"**{m['caption']}**\n\n![{m['caption']}]({rel})"))
        img_md[m["name"]] = f"![{m['caption']}]({rel})"
        figure_srcs[_figure_anchor(_figure_key(m["name"]))] = rel
        print(f"  拷贝截图 {m['name']} -> {dst}")
    content_md = assemble(title, body, "\n\n".join(evid_parts), meta, img_md)
    fmt = report_format(cfg, "local")
    content = build_interactive_html(
        title,
        a.verdict,
        content_md,
        manifest,
        flavor=_report_flavor(a, body),
        figure_srcs=figure_srcs,
        report_version=a.report_version,
    ) if fmt == "html" else content_md
    ext = "html" if fmt == "html" else "md"
    report_path = os.path.join(out_dir, f"{report_id}.{ext}")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(json.dumps({"mode": "local", "title": title, "report_id": report_id,
                      "format": fmt, "reportPath": report_path, "shotsDir": shot_dir}, ensure_ascii=False))


def run_doc_store(cfg, a, title, report_id, body, manifest, now, preview, tags=None):
    api = cfg["auth"]["api"]
    # 简便方式（推荐）：设 MAP_DOC_STORE_KEY=<scoped-agent-key>（带 document-store:write scope 的最小权限长效 Key），
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
    evidence = "\n\n".join(
        _with_figure_anchor(m["name"], f"**{m['caption']}**\n\n{{{{IMG:{m['name']}}}}}")
        for m in manifest
    )
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
    content = assemble(title, body, evidence, meta, manifest_names=[m["name"] for m in manifest])

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
        "tags": tags or [],  # 报告类型、状态、操作方式和档位走标签，不进标题
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
MOBILE_MIN_SHOTS = {"L0": 0, "L1": 1, "L2": 2}
MOBILE_MAX_WIDTH = 480
DEEP_DAILY_MIN_SHOTS = 12
JUNK_TARGETS = {"test", "测试", "xxx", "demo", "tmp", "临时", "aaa", "todo"}
PLACEHOLDER_PAT = re.compile(r"\{YYYY|\{target\}|\{project\}|\{verdict|\{date\}|\{commit\}|\{branch\}|\{sha\}|\{url\}|\{\{(?!EVIDENCE\}\}|IMG:)")
THIN_CELL_PAT = re.compile(r"^(同上|见上文|参见上文|略|省略|按常规|常规|待定|TBD|todo)$", re.I)
# #809：「同上第N条」是对前面某条已连图证据的合法复用（明确指向具体一条），
# 在证据连线检查里应豁免「0 证据」拒收（区别于裸「同上」——后者仍由 THIN_CELL_PAT 判为占位薄单元）。
DITTO_REF_PAT = re.compile(r"同上第\s*\d+\s*条")


MOBILE_NA_PAT = re.compile(r"移动端\s*(?:验收)?\s*不适用")
MOBILE_NA_BOUNDARY_PAT = re.compile(
    r"桌面原生|内部\s*(?:非页面|工具|证据|only|专用)|非页面(?:变更|改动|功能)?"
    r"|无\s*(?:移动|手机)\s*Web|不提供\s*(?:移动|手机)|internal[-\s]?only",
    re.I,
)


def _declares_mobile_not_applicable(body):
    """规则 §11.2 豁免：桌面原生页面 / 内部非页面变更可声明「移动端不适用」并说明产品边界，
    此类报告豁免移动端硬门禁。需同时满足：显式「移动端不适用」声明 + 产品边界理由。
    是否越界声称「移动端通过」属 Verdict 语义一致性，交由人/工具把关（见 validate_inputs 说明）。"""
    text = body or ""
    return bool(MOBILE_NA_PAT.search(text) and MOBILE_NA_BOUNDARY_PAT.search(text))


def _mobile_acceptance_errors(tier, body, manifest):
    """校验真实触控移动端证据；桌面 context 仅缩窄视口不能通过。"""
    need = MOBILE_MIN_SHOTS.get(tier, 0)
    if need == 0:
        return []
    # 规则 §11.2：明确不提供移动 Web 体验的桌面原生/内部非页面报告，声明「移动端不适用」
    # 并说明产品边界后，豁免移动端硬门禁。避免 API-only、后端、内部 CDS 证据报告
    # 因为没有移动 Web 面而被无差别拒收。
    if _declares_mobile_not_applicable(body):
        return []

    errors = []
    mobile_shots = []
    for shot in manifest:
        viewport = shot.get("viewport") or {}
        width = viewport.get("width") if isinstance(viewport, dict) else None
        touch_points = shot.get("touchPoints", shot.get("touch_points", 0))
        try:
            width_ok = 0 < int(width) <= MOBILE_MAX_WIDTH
            touch_ok = int(touch_points) >= 1
        except (TypeError, ValueError):
            width_ok = False
            touch_ok = False
        if shot.get("isMobile") is True and width_ok and touch_ok:
            mobile_shots.append(shot)

    if len(mobile_shots) < need:
        errors.append(
            f"[移动端] {tier} 需要 >= {need} 张真实触控移动端证据，当前 {len(mobile_shots)} 张。"
            f"必须使用 isMobile=true、hasTouch=true 的独立 context，manifest 记录 isMobile=true、"
            f"touchPoints>=1 且 viewport.width<={MOBILE_MAX_WIDTH}；桌面 setViewportSize 不算"
        )

    mobile_section = re.search(
        r"(?ms)^#{2,6}\s+[^\n]*移动端验收[^\n]*\n(.*?)(?=^#{2,6}\s+|\Z)",
        body or "",
    )
    if not mobile_section:
        errors.append("[移动端] 报告缺「移动端验收」章节")
    else:
        required_terms = {
            "视口": (r"视口|viewport",),
            "触控": (r"触控|touch",),
            "入口路径": (r"入口|路径|导航",),
            "结果状态": (r"结果|状态",),
            "滚动": (r"滚动|滑动",),
            "横向溢出": (r"横向|溢出",),
            "遮挡裁切": (r"遮挡|裁切",),
        }
        section = mobile_section.group(1)
        for label, patterns in required_terms.items():
            if not any(re.search(pattern, section, re.I) for pattern in patterns):
                errors.append(f"[移动端] 「移动端验收」章节缺{label}结论")

    if tier == "L2" and len(mobile_shots) >= need:
        stages = {str(shot.get("mobileStage") or "").strip().lower() for shot in mobile_shots}
        entry_stages = {"entry", "navigation", "action"}
        result_stages = {"result", "state"}
        if not stages.intersection(entry_stages) or not stages.intersection(result_stages):
            errors.append(
                "[移动端] L2 移动端证据必须分别标记入口/操作阶段与结果/状态阶段："
                "shot(...,{mobileStage:'entry'|'action'}) + shot(...,{mobileStage:'result'|'state'})"
            )
        if any(not (shot.get("mobilePathId") or shot.get("mobile_path_id")) for shot in mobile_shots):
            errors.append("[移动端] L2 移动端证据缺 mobilePathId，无法证明属于独立移动端用户路径")

    return errors


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
    """Return true only for explicit complex acceptance scenarios, not generic metadata columns.

    复杂验收必须是每日验收的超集：每日判定唯一入口 _declares_daily_acceptance
    命中即复杂，避免「算每日却不算复杂」的缝隙。"""
    if _declares_daily_acceptance(target, body):
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
    """每日验收判定的唯一入口：门禁（validate_inputs 的每日结构/证据要求）与
    皮肤（_report_flavor 的巡检特刊）都走这一个函数，保证「拿巡检刊头的报告
    必过每日门禁」（Codex P2：措辞并入门禁本体而不是各自维护两套正则）。

    措辞覆盖：紧邻与中间插词（每日视觉验收报告）、巡检系（每日巡检/巡检特刊）、
    英文变体（daily-yesterday/daily-visual/daily-patrol）。扫描面仍是
    _scope_declaration_text（target + 标题 + 范围声明行），正文散句不触发。
    """
    if _target_declares_daily_scope(target):
        return True
    text = _scope_declaration_text(target, body)
    return bool(re.search(
        r"(每日|昨日|昨天).{0,8}(验收|复验|测试|报告|巡检)|"
        r"(?:验收|复验|测试|报告|巡检).{0,8}(每日|昨日|昨天)|"
        r"巡检特刊|\bdaily[-_ ]?(?:yesterday|visual|patrol)\b",
        text,
        re.I,
    ))


def _infer_report_kind(a, body):
    """Resolve the stable title prefix for every executable acceptance report."""
    explicit = (getattr(a, "report_kind", "") or "").strip()
    if explicit:
        return explicit
    target = a.target or ""
    scope_text = _scope_declaration_text(target, body)
    if _declares_daily_acceptance(target, body):
        return "每日验收"
    rules = (
        ("缺陷复测", r"缺陷复测|defect[- ]retest"),
        ("视觉回归", r"视觉回归|visual[- ]regression"),
        ("发布验收", r"发布前(?:阻断)?验收|发布验收|release[- ]preflight"),
        ("分支验收", r"未发布分支|分支验收|unpublished[- ]branch"),
        ("Commit验收", r"commit\s*(?:验收|复验|测试|报告)|提交验收"),
        ("规范演练", r"规范演练|验收样本|acceptance[- ]sample"),
    )
    for kind, pattern in rules:
        if re.search(pattern, scope_text, re.I):
            return kind
    if getattr(a, "pr", None) or re.search(r"PR\s*#?\s*\d+|pull[- ]request", scope_text, re.I):
        return "PR验收"
    return "功能验收"


def _resolve_report_date(a, now):
    explicit = (getattr(a, "report_date", "") or "").strip()
    if explicit:
        return _validate_report_date(explicit)
    target_date = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", a.target or "")
    return _validate_report_date(target_date.group(1)) if target_date else now.strftime("%Y-%m-%d")


def _validate_report_date(value):
    """Require the stable YYYY-MM-DD title date contract."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        raise argparse.ArgumentTypeError("报告目标日期必须使用 YYYY-MM-DD 格式")
    try:
        datetime.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("报告目标日期不是有效日期") from exc
    return value


def _clean_title_focus(raw, project, report_kind, report_date, operation_type=""):
    """Keep only the human-distinguishing subject; project/status/type live in metadata."""
    generic = {
        project,
        report_kind,
        operation_type,
        "验收报告",
        "视觉验收",
        "自动验收",
        "每日巡检",
        "巡检特刊",
    }
    normalized = []
    for part in re.split(r"\s*[·|]\s*", raw or ""):
        value = re.sub(r"^(昨日|昨天|今日|当天)", "", part.strip())
        value = re.sub(r"\b20\d{2}-\d{2}-\d{2}\b", "", value).strip(" -·/")
        value = re.sub(r"(?:验收报告)$", "", value).strip(" -·/")
        if not value or value in generic or value == report_date:
            continue
        if value not in normalized:
            normalized.append(value)
    return " / ".join(normalized)


def build_report_title(a, cfg, now, body):
    """Unified contract: {report kind} · {focus} · {target date}."""
    report_kind = _infer_report_kind(a, body)
    report_date = _resolve_report_date(a, now)
    raw_focus = (getattr(a, "title_focus", "") or "").strip() or a.feature or a.target
    focus = _clean_title_focus(
        raw_focus,
        (cfg.get("project") or "").strip(),
        report_kind,
        report_date,
        a.type,
    )
    module = _clean_title_focus(
        a.module,
        (cfg.get("project") or "").strip(),
        report_kind,
        report_date,
        a.type,
    )
    if module and module not in focus and focus not in module:
        focus = f"{module} / {focus}" if focus else module
    if report_kind == "PR验收" and getattr(a, "pr", None):
        pr_label = f"#{a.pr}"
        if pr_label not in focus:
            focus = f"{pr_label} / {focus}" if focus else pr_label
    if report_kind == "Commit验收" and (a.commit or "").strip():
        commit_label = a.commit.strip()[:10]
        if commit_label not in focus:
            focus = f"{commit_label} / {focus}" if focus else commit_label
    return f"{report_kind} · {focus or '验收范围'} · {report_date}", report_kind, report_date


def _declares_deep_daily_acceptance(target, body):
    """Daily deep gate applies only to positive deep-acceptance declarations."""
    scope_text = _scope_declaration_text(target, body)
    daily_context = _declares_daily_acceptance(target, body) or bool(re.search(
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


CDS_PLATFORM_PAT = re.compile(
    r"(CDS\s*(?:平台|预览|部署|报告|验收中心|分支|branch|网络|路由|proxy|"
    r"extra-services|self-update|scheduler|smoke)|"
    r"\bcds/|cdscli|preview routing|branch status|deploy/smoke)",
    re.I,
)
CDS_AGENT_PAT = re.compile(r"(CDS\s*Agent|/cds-agent|CdsAgent)", re.I)
CDS_AGENT_ALLOWED_PAT = re.compile(
    r"(CDS\s*Agent\s*(?:专项|工作台|入口|页面|会话|runtime|session|tool-call)|"
    r"CdsAgent|/cds-agent|InfraAgent|remote-hosts)",
    re.I,
)
CDS_AGENT_BOUNDARY_NEGATED_PAT = re.compile(
    r"(无关|不相关|非.*证据|不是.*证据|不能.*证明|不.*证明|不作为|不可作为|"
    r"禁止.*证明|不得.*证明|未通过|不通过|无效证据|"
    r"弱相关|弱关联|未覆盖|未深测|关联不足|关联性不足|覆盖不足|"
    r"\bfail\b|\bfailed\b|\binvalid-evidence\b|\bnot-run\b)",
    re.I,
)
CDS_AGENT_EXPLICIT_BOUNDARY_PAT = re.compile(
    r"(不(?:能)?证明\s*CDS\s*(?:平台|预览|部署|报告|验收中心|分支)|"
    r"(?:只|仅)证明\s*CDS\s*Agent|CDS\s*Agent.*不(?:能)?证明\s*CDS\s*平台)",
    re.I,
)
CDS_AGENT_POSITIVE_RESULT_CELLS = {"pass", "passed", "done", "完成", "已完成", "通过", "已通过"}

VISUAL_PROBLEM_PAT = re.compile(
    r"(遮挡|覆盖|错位|溢出|截断|空白|留白|不可见|看不到|打不开|点击无效|"
    r"无响应|图片缺失|无图|右侧为空|左侧为空|布局|重叠|压住|挡住|"
    r"contrast|overflow|blank|overlap|blocked|invisible|missing image)",
    re.I,
)
COVERAGE_GAP_PAT = re.compile(
    r"(未覆盖|没有覆盖|覆盖不足|覆盖缺口|覆盖率|测试覆盖|用例覆盖|场景覆盖|路径覆盖|缺少覆盖|未测|漏测)",
    re.I,
)
DEFECT_SEVERITY_PAT = re.compile(r"\b(P[0-2])\b", re.I)


def _figure_anchor_to_manifest(manifest):
    out = {}
    for m in manifest or []:
        key = _figure_key(m.get("name"))
        anchor = _figure_anchor(key)
        if anchor:
            out[anchor] = m
    return out


def _problem_localization_errors(body, manifest):
    """P0/P1/P2 visual defects must point to a marked screenshot.

    This closes the common failure mode where the report says "遮挡/错位"
    but the reader cannot tell where the issue is in the image.
    """
    errs = []
    anchor_map = _figure_anchor_to_manifest(manifest)
    in_defects = False
    candidates = []
    for line in (body or "").splitlines():
        stripped = line.strip()
        if re.match(r"^##\s+缺陷清单", stripped):
            in_defects = True
            continue
        if in_defects and stripped.startswith("## "):
            in_defects = False
        if not in_defects or not stripped:
            continue
        if re.match(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$", stripped):
            continue
        if stripped.startswith("|"):
            cells = _split_markdown_table_row(stripped)
            if not cells or all(c in {"", "---"} for c in cells):
                continue
            severity_match = DEFECT_SEVERITY_PAT.search(cells[0]) or DEFECT_SEVERITY_PAT.search(" ".join(cells))
            if not severity_match:
                continue
            severity = severity_match.group(1).upper()
            row_text = " ".join(cells)
        else:
            row_text = re.sub(r"^[-*+]\s+", "", stripped)
            row_text = re.sub(r"^\d+[.)]\s+", "", row_text)
            row_text = re.sub(r"^\*\*(P[0-2])\*\*", r"\1", row_text, flags=re.I)
            severity_match = DEFECT_SEVERITY_PAT.search(row_text)
            if not severity_match:
                continue
            severity = severity_match.group(1).upper()
        candidates.append((severity, row_text))
    for severity, row_text in candidates:
        if severity not in {"P0", "P1", "P2"}:
            continue
        if COVERAGE_GAP_PAT.search(row_text):
            continue
        if not VISUAL_PROBLEM_PAT.search(row_text):
            continue
        anchors = re.findall(r"#(fig-[a-z0-9-]+)", row_text, re.I)
        for img_name in re.findall(r"\{\{IMG:([^}]+)\}\}", row_text):
            anchor = _figure_anchor(_figure_key(img_name))
            if anchor:
                anchors.append(anchor)
        if not anchors:
            refs = re.findall(r"图\s*([0-9]+[a-zA-Z]?)", row_text)
            for ref in refs:
                matches = [
                    _figure_anchor(_figure_key(m.get("name")))
                    for m in manifest or []
                    if (m.get("name") or "").lower().startswith(ref.lower())
                ]
                anchors.extend(a for a in matches if a)
        if not anchors:
            errs.append(
                f"[问题定位] {severity} 视觉缺陷没有链接到截图锚点。"
                f"缺陷行必须写成 [图XX](#fig-完整截图名), 并在图内框出问题：{row_text[:120]}"
            )
            continue
        for anchor in anchors:
            shot = anchor_map.get(anchor)
            if not shot:
                errs.append(f"[问题定位] 缺陷行引用 {anchor}，但 manifest 中找不到对应截图：{row_text[:120]}")
                continue
            if shot.get("annotated") is not True:
                errs.append(
                    f"[问题定位] {severity} 视觉缺陷引用的截图未记录为已标注：{shot.get('name') or anchor}。"
                    f"必须用 box/stepShot/stepClick 在图内框出具体问题, 不能只在文字里说：{row_text[:120]}"
                )
    return errs


def _row_has_positive_result(line):
    return any(c.strip().lower() in CDS_AGENT_POSITIVE_RESULT_CELLS for c in _split_markdown_table_row(line))


def _cds_agent_substitution_hits(body):
    """Detect rows that use CDS Agent as proof for CDS platform assertions."""
    hits = []
    for line in (body or "").splitlines():
        ls = line.strip()
        if not ls.startswith("|"):
            continue
        platform_probe = CDS_AGENT_EXPLICIT_BOUNDARY_PAT.sub("", ls)
        if not CDS_PLATFORM_PAT.search(platform_probe) or not CDS_AGENT_PAT.search(ls):
            continue
        has_positive_result = _row_has_positive_result(ls)
        # Failure/irrelevance rows are valid audit evidence: the gate should reject
        # substituted proof, not block reports from documenting that substitution failed.
        if not has_positive_result and CDS_AGENT_EXPLICIT_BOUNDARY_PAT.search(ls):
            continue
        if not has_positive_result and CDS_AGENT_BOUNDARY_NEGATED_PAT.search(ls):
            continue
        # Rows explicitly scoped to CDS Agent are allowed; mixed platform rows are not.
        if CDS_AGENT_ALLOWED_PAT.search(ls) and not re.search(
            r"(CDS\s*(?:平台|预览|部署|报告|验收中心|分支|branch|网络|路由|proxy|"
            r"extra-services|self-update|scheduler|smoke)|cdscli|branch status)",
            ls,
            re.I,
        ):
            continue
        hits.append(ls[:160])
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
    report_version = (getattr(a, "report_version", "") or "v0.9").strip()
    if not re.fullmatch(r"v\d+\.\d+", report_version):
        errs.append(
            f"[报告版本] 非法：{report_version!r}（应为 v<主版本>.<次版本>，且只能人工显式改版）"
        )
    need = TIER_MIN_SHOTS.get(a.tier, 3)
    if len(manifest) < need:
        errs.append(f"[证据] 截图数 {len(manifest)} < {a.tier} 下限 {need}")
    errs.extend(_manifest_figure_errors(manifest))
    errs.extend(_duplicate_evidence_errors(manifest))
    errs.extend(_mobile_acceptance_errors(a.tier, body, manifest))
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
        errs.extend(_daily_conclusion_contract_errors(a.verdict, body))
        for section in DAILY_REQUIRED_SECTIONS:
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
    cds_agent_hits = _cds_agent_substitution_hits(body)
    if cds_agent_hits:
        errs.append(
            "[证据错配] CDS 平台改动不能用 CDS Agent 页面作为通过证据；请拆分 CDS 平台与 CDS Agent 行，"
            "或补 cdscli/API/deploy/smoke/reports/preview routing 等平台证据。示例："
            + " | ".join(cds_agent_hits[:3])
        )
    errs.extend(_problem_localization_errors(body, manifest))
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
            # #809：明确引用「同上第N条」= 复用前面某条已连图证据，不算 0 证据断链，豁免拒收。
            # 注意仅豁免带序号的「同上第N条」；裸「同上」不在此豁免（由 THIN_CELL_PAT 判占位）。
            if DITTO_REF_PAT.search(tail):
                continue
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
    ap.add_argument(
        "--report-kind",
        default="",
        choices=REPORT_KINDS,
        help="标题固定前缀；缺省按目标语义推断，建议复杂验收显式传入",
    )
    ap.add_argument("--title-focus", default="", help="标题重点对象；缺省使用 --feature 或 --target")
    ap.add_argument(
        "--report-date",
        default="",
        type=_validate_report_date,
        help="标题目标日期，格式 YYYY-MM-DD；缺省从 --target 提取或使用当天",
    )
    ap.add_argument("--module", default="", help="模块（命名第2段，如 网页托管 / 知识库）")
    ap.add_argument("--feature", default="", help="功能（命名第3段，如 SaaS空间模型；缺省用 --target）")
    ap.add_argument("--type", default="", help="操作方式（命名第4段，如 新增功能 / 优化 / 修复）")
    ap.add_argument("--folder-path", default="", help="归档文件夹路径（'/'分隔可嵌套，如 每日验收/2026-07）。缺省依次回退 config.report.cdsFolder、--module（按模块自动归类）；三者都空才落项目根")
    ap.add_argument("--verdict", default="pass")
    ap.add_argument("--tier", default="L1")
    ap.add_argument("--report-md", required=True, help="正文 md（速览卡+九段，{{EVIDENCE}} 占位）")
    ap.add_argument("--manifest", required=True, help="截图清单 json：[{name,caption,path}]")
    ap.add_argument("--branch", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--pr", type=int, default=None, help="关联 PR 编号（E1 部署上下文，便于 E4 回写）")
    ap.add_argument(
        "--report-version",
        default="v0.9",
        help="验收档案版本号；默认 v0.9。只接受显式人工改版，不根据 Verdict 自动升级",
    )
    ap.add_argument("--force", action="store_true", help="越过准入校验（仅在确知合理时用，会打印告警）")
    a = ap.parse_args()

    cfg = json.load(open(a.config))
    # 职责分离（2026-06-25）：验收报告默认归 CDS 验收中心，技能不再分流到 MAP 知识库。
    # local 仍作离线兜底；旧 doc-store 仅在 config 显式保留时走（向后兼容，不推荐）。
    mode = cfg.get("report", {}).get("mode", "cds")
    now = datetime.datetime.now().astimezone()
    dt = now.strftime(cfg["report"].get("datetimeFormat", "%Y-%m-%d %H:%M:%S %Z%z"))
    verdict_cn = {"pass": "通过", "conditional": "有条件通过", "fail": "不通过"}.get(a.verdict, a.verdict)
    body = ensure_report_time(open(a.report_md, encoding="utf-8").read().lstrip(), dt)
    title, a.report_kind, a.report_date = build_report_title(a, cfg, now, body)
    # 项目由 projectId、状态由 verdict、操作方式与档位由 metadata/tags 表达，不再挤占标题。
    tags = [t for t in [verdict_cn, a.report_kind, a.type, a.tier] if (t or "").strip()]
    report_id = f"acc-{cfg['project']}-{now.strftime('%Y%m%d%H%M')}-{slugify(a.target)}"
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
