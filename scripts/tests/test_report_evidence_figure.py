#!/usr/bin/env python3
"""证据图契约守卫（report-design-system.md §1.6 / predicate-and-wiring-discipline.md 形状 9）。

背景：`{{IMG:<name>}}` 由 publish.py 的 img_embed() 展开成裸 `<figure><img><figcaption></figure>`，
不带任何 class，作者可以放在正文任何位置。2026-09-07 日报的尺寸规则却写成
`.story figure img{width:100%}`——附加章节把占位放在 .story 之外，四张 2880x1800 的截图
按原始像素平铺，撑破 960px 版心。模板样例里的图恰好都在 .story 里，所以「看起来有样式」，
保证却只在样例那一个位置成立。

本守卫钉四件事，并且**跑真函数**而不是扫源码字面量：
  1. 日报 / 周报模板都有无作用域的 `figure img` 顶层规则，胜出的 width 是 100%
     —— 用的是 publish.py 发布闸同一个 check_evidence_figure_css()，判定源只有一份（形状 3）
  2. img_embed() 实际吐出的标签就是那条规则要匹配的裸 <figure><img>（不带 class）；
     把它展开到模板里 .story **之外**的位置，仍然过闸（把样例挪个位置还对——形状 9 的判据）
  3. 红绿闭环：把规则改回 `.story figure img` 的坏版本必须判红；占位塞进 <img src> 必须被拒
  4. CI 接线：被测的两份模板 + publish.py + 本守卫都登记在 release-script-test 的 path filter 里（形状 7）

CI 通过 .github/workflows/ci.yml 的 `for t in scripts/tests/test_*.py` 自动执行。
"""
import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLISH = ".claude/skills/daily-report-summary/reference/publish.py"
TEMPLATES = [
    ("日报", ".claude/skills/daily-report-summary/reference/report-template-html.html"),
    ("周报", ".claude/skills/weekly-update-summary/reference/report-template-html.html"),
]
CI_WORKFLOW = ".github/workflows/ci.yml"
CI_FILTER_NAME = "release_scripts"
SELF = "scripts/tests/test_report_evidence_figure.py"

failures = []


def fail(msg):
    failures.append(msg)
    print("  [红] " + msg)


def load_publish():
    spec = importlib.util.spec_from_file_location("daily_publish", ROOT / PUBLISH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for fn in ("check_evidence_figure_css", "img_embed", "apply_evidence",
               "assert_placeholder_standalone", "assert_no_placeholder", "strip_html_comments"):
        if not hasattr(mod, fn):
            fail(f"publish.py 缺 {fn}()——守卫要跑的真函数不在，等于没测")
    return mod


def check_template(label, rel, pub):
    path = ROOT / rel
    if not path.is_file():
        fail(f"{label} 模板不存在：{rel}")
        return None
    text = pub.strip_html_comments(path.read_text(encoding="utf-8"))
    errs = pub.check_evidence_figure_css(text)
    for e in errs:
        fail(f"{label} 模板：{e}")
    return text


def check_expander_outside_story(label, text, pub):
    """展开物放在 .story 之外照样成立——这正是事故里失守的位置。"""
    embed = pub.img_embed("https://cfi.example/x.png", "图说", True)
    if not re.match(r"<figure>\s*<img\b", embed) or 'class="' in embed.split(">", 2)[1]:
        fail(f"img_embed 产物不是裸 <figure><img>：{embed[:80]}——契约挂靠的对象变了，本守卫的前提失效")
        return
    # 放在正文尾部（.paper 内、任何 .story 之外），占位按契约独立成行
    idx = text.rfind("</div>")
    body = text[:idx] + "\n<section class=\"extra\">\n{{IMG:probe}}\n</section>\n" + text[idx:]
    pub.assert_placeholder_standalone(body)
    out = pub.apply_evidence(body, {"probe": embed})
    pub.assert_no_placeholder(out)
    if embed not in out:
        fail(f"{label}：占位没有被展开成 img_embed 的产物")
    # 展开后再过一次闸：规则是全局的，位置在 .story 之外也必须绿
    for e in pub.check_evidence_figure_css(out):
        fail(f"{label}（展开物在 .story 之外）：{e}")


def check_red_green(label, text, pub):
    """守卫必须能红：把规则收回 .story 下 / 删掉 width，都要判红。"""
    scoped = re.sub(r"(?m)^(\s*)figure img\s*\{", r"\1.story figure img {", text, count=1)
    if scoped == text:
        fail(f"{label}：找不到 `figure img {{` 规则行，红绿闭环无法构造（模板改写法了？）")
        return
    if not pub.check_evidence_figure_css(scoped):
        fail(f"{label}：把规则收回 .story 下仍判绿——守卫没在测它以为在测的东西（形状 4）")
    no_width = re.sub(r"(?m)^(\s*figure img\s*\{[^}]*?)width:\s*100%;", r"\1", text, count=1)
    if no_width != text and not pub.check_evidence_figure_css(no_width):
        fail(f"{label}：删掉 width:100% 仍判绿")
    # 后写的同选择器规则会赢：追加一条 width:auto 必须判红（取胜者不取第一条——形状 6）
    overridden = text.replace("</style>", "figure img { width: auto; }\n</style>", 1)
    if not pub.check_evidence_figure_css(overridden):
        fail(f"{label}：后追加的 figure img{{width:auto}} 覆盖了 100% 仍判绿——判据取了第一条而不是胜者")
    # 条件块里的规则不算数（形状 8）：只在 @media 里声明 100%，顶层没有 → 必须红
    only_media = scoped.replace("</style>", "@media (max-width:1px){ figure img { width:100%; } }\n</style>", 1)
    if not pub.check_evidence_figure_css(only_media):
        fail(f"{label}：只在 @media 里声明的 figure img 被当成了无条件成立的证据")
    # 更高特异性 / !important / @media 里的竞争声明浏览器都会采用，判据只比对字面选择器就会放过
    # （Codex review 2026-09-07）。四种写法都必须红。
    for tag, extra in [
        ("更高特异性", "body figure img { width: auto; }"),
        ("!important 的低特异性", "img { width: auto !important; }"),
        ("子代组合器 + 伪类", ".paper figure > img:hover { width: 50%; }"),
        ("@media 内改宽", "@media (max-width: 640px) { figure img { width: 60%; } }"),
    ]:
        overridden = text.replace("</style>", extra + "\n</style>", 1)
        if not pub.check_evidence_figure_css(overridden):
            fail(f"{label}：{tag}的竞争规则 `{extra}` 仍判绿——浏览器会采用它，证据图又能按原始像素平铺")
    # 反向：别的规则也声明 width:100%（不打架）不能误拒
    harmless = text.replace("</style>", ".story figure img { width: 100%; }\n</style>", 1)
    if pub.check_evidence_figure_css(harmless):
        fail(f"{label}：同样声明 width:100% 的规则被误判为打架")


def check_placeholder_gate(pub):
    for tag, bad in [
        ("塞进 <img src>", '<p><img src="{{IMG:x}}" alt="a"></p>'),
        ("和文字同行（Codex review）", "<p>说明 {{IMG:x}}</p>"),
        ("包在行内元素里", "<span>{{IMG:x}}</span>"),
        ("一行两个占位", "{{IMG:a}} {{IMG:b}}"),
        ("EVIDENCE 与文字同行", "证据：{{EVIDENCE}}"),
    ]:
        try:
            pub.assert_placeholder_standalone(bad)
            fail(f"占位{tag}没有被拒：{bad}")
        except RuntimeError:
            pass
    try:
        pub.assert_placeholder_standalone("<p>前文</p>\n  {{IMG:x}}  \n<p>后文</p>\n{{EVIDENCE}}\n")
    except RuntimeError as e:
        fail(f"独立成行的占位被误拒：{e}")


def _glob_to_regex(p):
    out = ""
    i = 0
    while i < len(p):
        c = p[i]
        if p.startswith("**/", i):
            out += "(?:.*/)?"; i += 3; continue
        if p.startswith("**", i):
            out += ".*"; i += 2; continue
        if c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


def check_ci_wiring():
    path = ROOT / CI_WORKFLOW
    if not path.is_file():
        fail(f"找不到 {CI_WORKFLOW}")
        return
    pats, indent = [], None
    for line in path.read_text(encoding="utf-8").splitlines():
        if indent is None:
            m = re.match(r"^(\s*)%s:\s*$" % re.escape(CI_FILTER_NAME), line)
            if m:
                indent = len(m.group(1))
            continue
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        cur = len(line) - len(line.lstrip())
        if cur <= indent and not line.lstrip().startswith("-"):
            break
        m = re.match(r"^\s*-\s*['\"]?([^'\"]+)['\"]?\s*$", line)
        if m:
            pats.append(m.group(1).strip())
    if not pats:
        fail(f"{CI_WORKFLOW} 里解析不到 {CI_FILTER_NAME} 的 path filter")
        return
    regexes = [_glob_to_regex(p) for p in pats]
    for rel in [PUBLISH, SELF] + [r for _, r in TEMPLATES]:
        if not any(r.match(rel) for r in regexes):
            fail(f"{rel} 不在 {CI_FILTER_NAME} 的 path filter 里——只改它的 PR 不会跑本守卫（形状 7）")


print("加载 publish.py 真函数")
pub = load_publish()
if not failures:
    for label, rel in TEMPLATES:
        print(f"检查 {label} 模板：{rel}")
        text = check_template(label, rel, pub)
        if text:
            check_expander_outside_story(label, text, pub)
            check_red_green(label, text, pub)
    print("检查占位写法闸")
    check_placeholder_gate(pub)
    print("检查 CI 接线")
    check_ci_wiring()

print("-" * 60)
if failures:
    print(f"证据图契约守卫未通过：{len(failures)} 项")
    sys.exit(1)
print(f"证据图契约守卫通过（{len(TEMPLATES)} 份模板 / 发布闸两条 / CI 接线）")
