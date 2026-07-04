#!/usr/bin/env python3
"""日报发布到知识库（文档空间），或 --local 落本地文件。

find-or-create「日报知识库」→（有截图则先上传图、回填 {{IMG:}}/{{EVIDENCE}} 占位）→
建条目 → 写正文（带 hasContent 校验 + 空壳兜底）→ 出分享链。
鉴权：优先 DAILY_DOC_STORE_KEY=sk-ak-*（Bearer，最小权限 document-store:write），
回退 AI_ACCESS_KEY 超级密钥 + X-AI-Impersonate。

格式二选项（--report-md / --report-html 恰好传一个）：
  --report-md    Markdown 版（contentType=text/markdown，MarkdownViewer 渲染）
  --report-html  报纸版（contentType=text/html，知识库 FilePreview 走 srcDoc 沙箱 iframe
                 真渲染；HTML 必须自包含：内联 CSS、无外部资源、**无 JS**——沙箱不给
                 allow-scripts，脚本不会执行；必须自带 <meta viewport>）

用法：
  export AI_ACCESS_KEY=...
  python3 publish.py --base https://main-prd-agent.miduo.org \
    --impersonate inernoro --title "日报-2026-05-31-今日大事早知道" \
    --daily-date 2026-05-31 --report-md /tmp/daily.md \
    --manifest /tmp/acc_shots/manifest.json   # 可选：harness 产出的截图清单
  # HTML 报纸版：
  python3 publish.py --base ... --title "..." --report-html /tmp/daily.html
  # 无密钥 / 无文档空间时退化为本地：
  python3 publish.py --local --title "..." --report-md /tmp/daily.md --out fallback.md \
    --manifest /tmp/acc_shots/manifest.json
"""
import argparse, json, os, subprocess, time, sys, re, shutil
from html import unescape as html_unescape
from html.parser import HTMLParser

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
    # 优先 DAILY_DOC_STORE_KEY，回退验收技能共用的 MAP_DOC_STORE_KEY（都是 document-store:write scoped key）
    key = os.environ.get("DAILY_DOC_STORE_KEY", "").strip() or os.environ.get("MAP_DOC_STORE_KEY", "").strip()
    if key:
        h = ["-H", f"Authorization: Bearer {key}"]
        print("  鉴权：scoped key（DAILY_DOC_STORE_KEY / MAP_DOC_STORE_KEY，最小权限）")
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
        # 列表失败（鉴权/瞬时错误）绝不能当成"库不存在"——否则会误建重复同名私有库。
        if not res.get("success"):
            raise RuntimeError("列出知识库失败，无法判定「日报知识库」是否存在（拒绝盲目新建以免重复）："
                               + (json.dumps(res.get("error"), ensure_ascii=False)[:160] if res.get("error") else "未知错误"))
        data = res.get("data") or {}            # data 可能为 null
        items = data.get("items") or []         # items 可能为 null
        for s in items:
            if s.get("name") == name:
                return s                          # 返回整个 store 对象（含 isPublic），便于复用前校验可见性
        has_next = data.get("hasNextPage")
        if has_next is False or len(items) < 100:
            return None                          # 真·翻到尾仍无 → 确认不存在
        page += 1
        if page > 1000:                          # 防无限循环（需 10 万+ 满页库才触顶）；触顶则报错而非误判不存在
            raise RuntimeError("知识库分页超过 1000 页仍未翻到尾，疑似分页异常，停止以免误建重复库")


def resolve_daily_date(daily_date, title):
    if (daily_date or "").strip():
        return daily_date.strip()
    m = DATE_RE.search(title or "")
    return m.group(1) if m else ""


def load_manifest(path):
    """加载并校验截图清单。Phase 4.5 硬要求：每张图必须有"说明验证了什么"的 caption、
    且文件就绪、无 harness warnings——不达标 fail-fast，不让弱 caption/未就绪图混进日报。"""
    if not path:
        return []
    m = json.load(open(path, encoding="utf-8"))
    errs = []
    for item in m:
        name = item.get("name") or item.get("path", "")
        p = item.get("path", "")
        if not os.path.isfile(p) or os.path.getsize(p) < 1024:
            errs.append(f"截图缺失/过小(<1KB)：{name}")
        cap = (item.get("caption") or "").strip()
        if not cap:
            errs.append(f"截图无 caption（必须说明验证了什么）：{name}")
        elif cap == name or len(cap) < 6:
            errs.append(f"截图 caption 太弱（只写名字/过短，需写清验证点）：{name} -> {cap!r}")
        ws = item.get("warnings") or []
        if ws:  # harness 在截图前后做就绪校验，把问题写进 warnings；这里提升为拒发硬条件
            errs.append(f"截图未就绪/有问题：{name} -> {' | '.join(ws)}")
    if errs:
        raise RuntimeError("截图清单校验未通过（Phase 4.5 要求每张图就绪且说明验证点）：\n  - " + "\n  - ".join(errs))
    return m


def apply_evidence(body, name_to_md):
    """把 {{IMG:<name>}} 换成对应图、{{EVIDENCE}} 换成全部图集中段。

    无截图时**不**把 {{EVIDENCE}} 替换成空串——保留占位，让 assert_no_placeholder 拒发，
    避免"要求配图却静默发出空证据段"。{{IMG:<name>}} 同理：无对应截图就留着占位被拒。
    """
    content = body
    for name, md in name_to_md.items():
        content = content.replace("{{IMG:%s}}" % name, md)
    if name_to_md:  # 仅在确有截图时才回填 {{EVIDENCE}}
        evidence = "\n\n".join(name_to_md.values())
        content = content.replace("{{EVIDENCE}}", evidence)
    return content


def html_escape(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def strip_html_comments(html):
    """剥掉 <!-- --> 注释。两个用途：
    1. 校验前剥离——模板头部说明注释里合法地写着「禁 data:image」等字样，
       不剥离会让校验误伤模板本身（Codex P2）；
    2. 发布前剥离——后端知识库正文守卫同样按子串扫描，注释里的示例字样会被误拒。"""
    return re.sub(r"<!--.*?-->", "", html, flags=re.S)


_EXT_CSS = re.compile(r'url\(\s*["\']?\s*(?:https?:)?//', re.I)
_EXT_IMPORT = re.compile(r'@import\s+["\']\s*(?:https?:)?//', re.I)


def _is_external(url):
    u = (url or "").strip().lower()
    return u.startswith("http://") or u.startswith("https://") or u.startswith("//")


class _ReportScanner(HTMLParser):
    """自包含守卫的属性级扫描器（终结正则猫鼠游戏的实现，Codex P2 六轮后重写）。

    为什么用 HTMLParser 而不是正则：convert_charrefs=True（默认）让属性值在回调前
    完成字符引用解码，与浏览器同口径——&#104;ttps:// 这类实体编码绕过天然失效；
    无引号/换行/大小写等 HTML 词法变体也全部由 parser 归一，不再逐个打补丁。
    <style>/<script> 内容按 CDATA 交给 handle_data 原文（浏览器同样不在其中解码实体），
    CSS 检查用正则扫这些原文块 + 已解码的 style 属性值。
    """

    # 加载型属性（任意标签上出现即发起请求）；href 单独按标签区分导航型/加载型
    LOAD_ATTRS = {"src", "poster", "background", "formaction"}
    HREF_LOADING_TAGS = {"link", "image", "use", "feimage"}  # 样式表/预加载 + SVG 引用

    def __init__(self):
        super().__init__()
        self.errs = []
        self.has_viewport = False
        self.has_script = False
        self._in_style = False
        self.css_chunks = []

    def handle_starttag(self, tag, attrs):
        self._check(tag, attrs)
        if tag == "style":
            self._in_style = True
        if tag == "script":
            self.has_script = True

    def handle_startendtag(self, tag, attrs):
        self._check(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "style":
            self._in_style = False

    def handle_data(self, data):
        if self._in_style:
            self.css_chunks.append(data)

    def _err(self, msg):
        if msg not in self.errs:
            self.errs.append(msg)

    def _check(self, tag, attrs):
        if tag == "base":
            # <base> 会把全页相对 URL 的解析基址改走（外域=外链绕过，站内相对 base 也会
            # 静默改写资源解析），自包含报纸没有任何正当用途，整标签禁用（Bugbot Medium）
            self._err("含 <base> 标签——会改写全页相对路径的解析基址（可指向外域），自包含报纸禁用")
            return
        if tag == "meta":
            d = dict(attrs)
            if (d.get("name") or "").strip().lower() == "viewport":
                self.has_viewport = True
            # meta refresh 会让沙箱 iframe 立即导航/拉取目标地址（外域即外链绕过），
            # 报纸页面不存在正当的刷新跳转，整个禁用（Codex P2）
            if (d.get("http-equiv") or "").strip().lower() == "refresh":
                self._err("含 <meta http-equiv=refresh>——沙箱 iframe 会立即跳转并拉取目标地址，自包含报纸禁用")
        for name, val in attrs:
            if val is None:
                continue
            n, v = name.lower(), val.strip()
            if n in self.LOAD_ATTRS or (n == "data" and tag == "object"):
                self._check_load_url(tag, n, v)
            elif n == "srcset":
                for part in v.split(","):
                    cand = part.strip().split()[0] if part.strip() else ""
                    if cand:
                        self._check_load_url(tag, "srcset", cand)
            elif n in ("href", "xlink:href") and tag in self.HREF_LOADING_TAGS:
                self._check_load_url(tag, n, v)
            if n == "style" and v:
                self.css_chunks.append(v)

    def _check_load_url(self, tag, attr, url):
        """加载型 URL 的统一判定：外链与 data:image 两条禁令对所有加载位置一视同仁。
        parser 已完成实体解码，data&#58;image 这类编码形态在此处即原形（Codex P2）。"""
        if _is_external(url):
            self._err(f"<{tag} {attr}> 引用外部加载资源（{url[:60]}）——必须自包含，图片仅允许知识库 upload 返回的站内 URL（{{{{IMG:}}}} 占位流程）；导航链接请用 <a href>")
        if url.lower().lstrip().startswith("data:image"):
            self._err(f"<{tag} {attr}> 含 data:image——后端知识库正文有防破图守卫会拒存，请改站内 URL 或内联 SVG 标签")


def validate_html_report(body):
    """报纸版 HTML 硬校验，返回问题清单（空 = 通过）。属性层走 _ReportScanner，
    CSS 层正则扫 <style> 原文与 style 属性（已解码）。"""
    errs = []
    low = body.lower()
    if "<html" not in low:
        errs.append("不是完整 HTML 文档（缺 <html>）——报纸版必须是自包含整页")
    # 后端守卫按原文子串扫 data:image，这里保持同口径的兜底（属性层另有解码后检查）
    if "data:image" in low:
        errs.append("含 data:image——后端知识库正文有防破图守卫会直接拒存，纹理/图标请改纯 CSS 渐变或内联 SVG 标签")
    sc = _ReportScanner()
    sc.feed(body)
    sc.close()
    if not sc.has_viewport:
        errs.append("缺 <meta name=\"viewport\">——移动端会按 980px 桌面视口缩放，整页变小")
    if sc.has_script:
        errs.append("含 <script>——知识库沙箱 iframe 不给 allow-scripts，脚本不会执行，请改纯 CSS 实现")
    css = "\n".join(sc.css_chunks)
    if _EXT_CSS.search(css) or _EXT_IMPORT.search(css):
        errs.append("CSS 里有外部加载（url() 或 @import 指向 http/ // 外链）——背景图/字体必须内联或改纯 CSS，沙箱 iframe 仍会真实发起这些请求")
    # style 属性值经 parser 实体解码后进 css_chunks，原文子串守卫看不到解码形态，
    # data:image 禁令必须在解码后的 CSS 层再扫一次（Codex P2）
    if "data:image" in css.lower():
        errs.append("CSS 里含 data:image（含实体编码形态）——后端防破图守卫禁令同样适用，背景图请改纯 CSS 渐变或站内 URL")
    errs.extend(sc.errs)
    return errs


def html_visible_text(html, limit=200):
    """从 HTML 提取可读文本前 limit 字，作条目摘要（列表/卡片/搜索片段展示用）。
    必须解码实体（与后端 ToIndexableText 的 HtmlDecode 同口径），否则摘要里
    出现字面 &amp; 等序列，反而覆盖后端已正确解码的摘要（Bugbot Low）。"""
    text = strip_html_comments(html)
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1\s*>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def img_embed(url_or_path, caption, is_html):
    """按格式生成截图嵌入片段：md 走 ![]()，html 走 <figure>（吃 HTML 模板的 figure 样式）。"""
    if is_html:
        cap = html_escape(caption)
        return f'<figure><img src="{html_escape(url_or_path)}" alt="{cap}"><figcaption>{cap}</figcaption></figure>'
    return f"![{caption}]({url_or_path})"


def assert_no_placeholder(content):
    """发布前硬闸：正文残留 {{IMG:}}/{{EVIDENCE}} 占位 → 拒发，避免读者看到坏占位。"""
    left = PLACEHOLDER_RE.findall(content)
    if left:
        raise RuntimeError(
            "正文残留未替换的截图占位 " + ", ".join(sorted(set(left))) +
            "：要么传 --manifest 提供对应截图，要么从正文删掉这些占位后再发。")


def run_local(a, body, manifest, is_html):
    ext = "html" if is_html else "md"
    out = a.out or f"daily-{resolve_daily_date(a.daily_date, a.title) or 'report'}.{ext}"
    name_to_md = {}
    if manifest:
        shot_dir = os.path.splitext(out)[0] + "_shots"
        os.makedirs(shot_dir, exist_ok=True)
        for m in manifest:
            dst = os.path.join(shot_dir, f"{m['name']}.png")
            shutil.copyfile(m["path"], dst)
            cap = m.get("caption", m["name"])
            rel = f"./{os.path.basename(shot_dir)}/{m['name']}.png"
            name_to_md[m["name"]] = img_embed(rel, cap, is_html)
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
    ap.add_argument("--report-md", default="", help="Markdown 版正文（以 # 标题打头，可含 {{IMG:<name>}}/{{EVIDENCE}} 占位）")
    ap.add_argument("--report-html", default="", help="报纸版 HTML 正文（自包含：内联 CSS、自带 viewport、禁 JS/外部资源）")
    ap.add_argument("--daily-date", default="", help="metadata.dailyDate（YYYY-MM-DD）；缺省时从标题提取")
    ap.add_argument("--manifest", default="", help="harness 截图清单 json：[{name,caption,path}]；有截图时必传")
    ap.add_argument("--local", action="store_true", help="不发网络，落本地文件（无密钥/无文档空间时用）")
    ap.add_argument("--out", default="", help="--local 模式输出路径")
    a = ap.parse_args()

    if bool(a.report_md) == bool(a.report_html):
        sys.stderr.write("[错误] --report-md 与 --report-html 恰好传一个（格式二选项）。\n")
        sys.exit(6)
    is_html = bool(a.report_html)

    if is_html:
        body = open(a.report_html, encoding="utf-8").read().lstrip()
        # 注释先剥掉再校验/发布：模板头注释里合法出现「data:image」等示例字样，
        # 不剥会误伤模板；后端正文守卫同为子串扫描，注释不剥也会被后端误拒（Codex P2）
        body = strip_html_comments(body)
        errs = validate_html_report(body)
        if errs:
            raise RuntimeError("HTML 报纸版校验未通过：\n  - " + "\n  - ".join(errs))
    else:
        body = open(a.report_md, encoding="utf-8").read().lstrip()
        if not body.startswith("#"):
            body = f"# {a.title}\n\n" + body
    manifest = load_manifest(a.manifest)

    if a.local:
        run_local(a, body, manifest, is_html)
        return
    if not a.base:
        sys.stderr.write("[错误] doc-store 模式需要 --base；或改用 --local。\n")
        sys.exit(5)

    base = a.base.rstrip("/") + API
    H = headers(a.impersonate)
    HJ = headers(a.impersonate, with_json=True)

    # find-or-create store（分页查找）
    existing = find_store(base, H, STORE_NAME)
    created_store = False
    if existing:
        rid = existing["id"]
        # 日报库按私有创建；若复用到一个同名【公开】库，私有日报会悄悄进公开库——告警（对齐验收技能纪律 4）
        if existing.get("isPublic"):
            print(f"  [告警] 复用的「{STORE_NAME}」是公开库(isPublic=true)，日报通常应私有；"
                  "如非本意请把该库设为私有，或改用别的库名。")
        print(f"  复用知识库「{STORE_NAME}」id={rid}（isPublic={existing.get('isPublic')}）")
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
            name_to_md[m["name"]] = img_embed(url, cap, is_html)
            # upload 会建一个文件条目，取 URL 后删掉，避免库里多出图片条目
            tmp_eid = (d.get("entry") or {}).get("id")
            if tmp_eid:
                try:
                    curl(H + ["-X", "DELETE", f"{base}/entries/{tmp_eid}"])
                except Exception as de:
                    print(f"  [告警] 截图临时条目 {tmp_eid} 删除失败（库里可能残留一个图片条目，可手动清理）：{str(de)[:80]}")
            print(f"  上传截图 {m['name']} -> {url}")
        body = apply_evidence(body, name_to_md)
        assert_no_placeholder(body)
    except Exception as e:
        print(f"  截图上传/占位回填失败：{str(e)[:140]}")
        rollback_store_if_new()
        raise

    # create entry（失败则回滚新建的库）
    daily_date = resolve_daily_date(a.daily_date, a.title)
    meta = {"kind": "daily-report", "dailyDate": daily_date,
            "format": "html" if is_html else "md"}
    content_type = "text/html" if is_html else "text/markdown"
    try:
        eid = curl(HJ + ["-X", "POST", "-d", json.dumps({
            "title": a.title, "summary": a.title if is_html else f"# {a.title}",
            "sourceType": "reference", "contentType": content_type,
            "tags": ["日报", "今日大事"], "metadata": meta,
        }), f"{base}/stores/{rid}/entries"])["data"]["id"]
    except Exception as e:
        print(f"  建条目失败：{str(e)[:120]}")
        rollback_store_if_new()
        raise
    print(f"  条目 id={eid} title={a.title} dailyDate={daily_date} shots={len(manifest)}")

    # write content + verify hasContent（空壳兜底）
    # content_state(): True=确认有正文 / False=确认为空 / None=验证不可达(524等，不能下结论)
    def content_state():
        try:
            r = curl(H + [f"{base}/entries/{eid}/content"], retries=2)
            if not r.get("success"):
                return None
            return bool((r.get("data") or {}).get("hasContent"))
        except Exception:
            return None

    def put_content():
        try:
            w = curl(HJ + ["-X", "PUT", "-d", json.dumps({"content": body}), f"{base}/entries/{eid}/content"])
            return bool(w.get("success"))
        except Exception as e:
            print(f"  写正文异常：{str(e)[:120]}")
            return False

    put_ok = put_content()
    print(f"  写正文 put_ok={put_ok}")
    state = content_state()
    # 先处理"确认为空"：即便 PUT 返回 success，但 GET 明确 hasContent=false（returned-but-not-persisted）
    # 也必须再写一次；仍为空才算失败（Codex：put_ok 单独不足以判定已发布）。
    if state is False:
        put_ok = put_content()
        state = content_state()

    if state is True:
        print(f"  正文已校验落库 hasContent=true（put_ok={put_ok}）")
    elif state is False:
        # 重试后仍确认为空壳 → 清理，不留断头报告
        try:
            curl(H + ["-X", "DELETE", f"{base}/entries/{eid}"], retries=2)
            print(f"  正文确认为空，已删空壳条目 {eid}")
        except Exception:
            print(f"  正文确认为空且删除失败；稳定后请手动删条目 {eid}")
        rollback_store_if_new()
        raise RuntimeError("正文写入未生效(hasContent=false)，请稍后重跑")
    elif put_ok:
        # state=None：验证接口不可达，但 PUT 已返回成功 → 接受，不删（Cursor High：勿误删已落库正文）
        print(f"  正文 PUT 成功，但验证接口暂不可达(state=None)——按已发布处理，不删条目")
    else:
        # 既没 PUT 成功又无法验证 → 保留条目（可能空壳，也可能已落库），交人工确认，不盲删不盲重跑
        raise RuntimeError(
            f"正文写入结果未确认（PUT 未返回成功且验证接口不可达）。已保留条目 {eid} 避免误删，"
            "请稍后登录该库人工确认/重写，勿盲目重跑造成重复。")

    # html 条目摘要兜底：正文 PUT 会用正文前 200 字重算 summary，旧版后端不剥标签时
    # 列表/卡片/搜索会展示裸 <!DOCTYPE html> 片段（Bugbot Medium）。发布成功后回写
    # "剥标签可读文本"摘要，新旧后端行为一致（条目更新端点是部分更新，只动 summary）。
    if is_html:
        try:
            vis = html_visible_text(body)
            ok = curl(HJ + ["-X", "PUT", "-d", json.dumps({"summary": vis or a.title}),
                            f"{base}/entries/{eid}"]).get("success")
            print(f"  摘要回写(html 剥标签) ok={ok}")
        except Exception as e:
            print(f"  [告警] 摘要回写失败（列表可能显示原始 HTML 片段，可登录后手动改摘要）：{str(e)[:100]}")

    # share link —— 必须带 entryId 把分享限定到本篇；不传 entryId 后端会建"整库分享"，
    # 一条日报链接就能浏览私有「日报知识库」里的全部日报（Codex P2 隐私修复）。
    share_url = None
    try:
        tok = curl(HJ + ["-X", "POST", "-d", json.dumps({"title": a.title, "expiresInDays": 0, "entryId": eid}),
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
