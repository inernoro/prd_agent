#!/usr/bin/env python3
"""米多刊系刊徽守卫。

背景：报告模板必须**自包含**（内联 CSS/SVG、无外部资源，见 daily-report-summary 的
publish.py 发布闸），所以同一枚刊徽在日报模板、周报模板、验收生成器里各存了一份拷贝，
无法靠 import 共享。这正是 .claude/rules/predicate-and-wiring-discipline.md 形状 3
（判据分裂成多份然后各自漂移）的典型土壤——改一处忘一处不会有任何报错，
只会让某一刊悄悄戴上别人的徽。

本守卫扫真实文件，钉死三件事：
  1. 每个刊物的产物里有且只有**它自己**那枚刊徽（错配 / 漏装 / 混装都红）
  2. 刊徽 SVG 结构可用（mask/clipPath 的 id 全部能解析，否则渲染出来是空白）
  3. 刊徽是纯内联的（不引外部资源），不会被发布闸拒收

CI 通过 .github/workflows/ci.yml 的 `for t in scripts/tests/test_*.py` 自动执行。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

# 刊物 -> (产物文件, 该刊物应有的刊徽)
# 月报（sun）尚无模板，故不在此表；它的刊徽定义保留在设计系统规则里备用，
# 等 monthly 模板落地时按同样方式接进来（见规则「刊徽注册表」一节）。
EXPECTED = [
    ("日报", ".claude/skills/daily-report-summary/reference/report-template-html.html", {"moon"}),
    ("周报", ".claude/skills/weekly-update-summary/reference/report-template-html.html", {"earth"}),
    # 验收与每日巡检共用同一个生成器，按 flavor 分流，故该文件应同时含两枚
    ("验收/巡检", ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py",
     {"polaris", "comet"}),
]

ALL_KINDS = {"moon", "earth", "sun", "polaris", "comet"}

failures = []


def fail(msg):
    failures.append(msg)
    print(f"  [FAIL] {msg}")


def check_file(label, rel, expected_kinds):
    path = ROOT / rel
    if not path.is_file():
        fail(f"{label}: 产物文件不存在 {rel}")
        return
    text = path.read_text(encoding="utf-8")

    found = set(re.findall(r'data-emblem="([a-z]+)"', text))

    missing = expected_kinds - found
    if missing:
        fail(f"{label}({rel}): 缺刊徽 {sorted(missing)}——该刊物的报头会没有水印")

    # 混装：装了别的刊物的徽 = 读者会把这一刊认成另一刊，比没有更糟
    wrong = (found & ALL_KINDS) - expected_kinds
    if wrong:
        fail(f"{label}({rel}): 混入了不属于它的刊徽 {sorted(wrong)}"
             f"（应为 {sorted(expected_kinds)}）——会把这一刊错认成另一刊")

    # 每枚只该出现一次；重复会导致 SVG 内部 id 撞车，后一份引用到前一份的 mask
    for kind in expected_kinds:
        n = text.count(f'data-emblem="{kind}"')
        if n > 1:
            fail(f"{label}({rel}): 刊徽 {kind} 出现 {n} 次——"
                 f"SVG 内部 id 会撞车，第二枚会引用到第一枚的 mask/clip")

    for kind in sorted(found & ALL_KINDS):
        check_svg_integrity(label, rel, kind, text)


def check_svg_integrity(label, rel, kind, text):
    """截出该刊徽的 SVG 片段，验证 id 引用能解析、且不引外部资源。

    为什么要查 id：mask/clipPath 引不到就渲染成空白或整块实心——
    页面不报错，肉眼在 0.13 透明度下也未必看得出，属于典型的静默失效。
    """
    m = re.search(r'<svg[^>]*data-emblem="%s".*?</svg>' % re.escape(kind), text, re.S)
    if not m:
        fail(f"{label}: {kind} 的 <svg> 标签不完整（截不出闭合片段）")
        return
    frag = m.group(0)

    defined = set(re.findall(r'\bid="([^"]+)"', frag))
    used = set(re.findall(r'url\(#([^)]+)\)', frag))
    dangling = used - defined
    if dangling:
        fail(f"{label}: {kind} 引用了未定义的 id {sorted(dangling)}——"
             f"mask/clipPath 解析失败，刊徽会渲染成空白或实心块")

    # id 必须带 emb- 前缀：报告正文里可能有别的 SVG（版画插图/图表），
    # 裸 id 撞车同样会静默串味
    for i in sorted(defined):
        if not i.startswith("emb-"):
            fail(f"{label}: {kind} 的内部 id {i!r} 缺 emb- 前缀，"
                 f"可能与正文插图的 id 撞车")

    if re.search(r'(?:href|src)\s*=\s*["\']https?://', frag) or "data:image" in frag:
        fail(f"{label}: {kind} 含外部资源或 data:image——违反自包含要求，会被发布闸拒收")

    if 'viewBox="0 0 120 120"' not in frag:
        fail(f"{label}: {kind} 的 viewBox 不是 0 0 120 120——"
             f"刊系刊徽统一画布，尺寸不一致会导致同一 CSS 下大小不一")


def check_css_wiring(label, rel):
    """光有 SVG 不够：CSS 没接上的话，刊徽会当成普通块元素挤进报头把版面撑歪。

    判据必须**只看 .emblem 自己的声明块**，不能在整个文件里搜关键字——
    模板里别处也有 position:absolute，全文搜索时把 .emblem 那条删掉照样能搜到，
    等于没判（本守卫第一版就是这么写的，红绿自测时第 4 项该红没红才发现）。
    """
    path = ROOT / rel
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")

    # 取出所有选择器含 .emblem 的规则块（`{` 或 f-string 里的 `{{` 都认），
    # 排除 `.emblem svg` 这种只管内部 svg 尺寸的从属规则。
    bodies = []
    for m in re.finditer(r'([^{};\n]*\.emblem[^{};\n]*)\{\{?([^}]*)\}', text):
        selector, body = m.group(1), m.group(2)
        if "svg" in selector:
            continue
        bodies.append(re.sub(r"\s+", "", body))

    if not bodies:
        fail(f"{label}({rel}): 找不到 .emblem 的 CSS 规则——刊徽没有样式，"
             f"会当成普通块元素挤进报头 flex 流")
        return

    # 基础规则（非 media query 覆盖）必须同时具备这两条，否则它不是「水印」而是「遮挡物」
    required = [
        ("position:absolute", "水印必须绝对定位，否则会挤进报头 flex 流把版面撑歪"),
        ("pointer-events:none", "水印压在文字上层会挡住选中/点击"),
    ]
    for needle, why in required:
        if not any(needle in b for b in bodies):
            fail(f"{label}({rel}): .emblem 规则里没有 {needle} —— {why}")

    # 透明度必须真的「浅」：写成 1 就不是水印了，会盖住报头文字
    for b in bodies:
        mo = re.search(r"opacity:([0-9.]+)", b)
        if mo and float(mo.group(1)) > 0.3:
            fail(f"{label}({rel}): .emblem 的 opacity={mo.group(1)} 过高，"
                 f"水印会盖住报头文字（约定 ≈0.13）")


print("米多刊系刊徽守卫")
print("-" * 60)
for label, rel, kinds in EXPECTED:
    print(f"检查 {label}: {rel}")
    check_file(label, rel, kinds)

# 三处的水印都必须是「绝对定位 + 低透明度 + 不吃鼠标」，否则不是水印而是遮挡物
for label, rel in [
    ("日报", ".claude/skills/daily-report-summary/reference/report-template-html.html"),
    ("周报", ".claude/skills/weekly-update-summary/reference/report-template-html.html"),
    ("验收/巡检", ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"),
]:
    check_css_wiring(label, rel)

print("-" * 60)
if failures:
    print(f"刊徽守卫未通过：{len(failures)} 项")
    sys.exit(1)
print(f"刊徽守卫通过（{len(EXPECTED)} 个产物 / {sum(len(k) for _, _, k in EXPECTED)} 枚刊徽）")
