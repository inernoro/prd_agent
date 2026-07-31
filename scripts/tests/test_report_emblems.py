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
但「被 CI 引用」只是必要条件——那道闸有 path filter，被测文件不登记进去，
守卫就只在自己被改时才跑，而漂移恰恰发生在被测文件那边。故本守卫最后一项
自查就是 check_ci_wiring()：确认自己的每个输入都在闸的 filter 里。
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

RULE_DOC = ".claude/rules/report-design-system.md"

# 产物 -> 规则 §1.4 表里的 key。**只映射，不存数值**：
# 数值一律运行时从规则表解析。守卫若自己存一份副本，就成了本 PR 要防的同一种分裂
# （改规则不改守卫仍绿、改实现加守卫不改规则也仍绿）——等于在防漂移的工具里
# 内置一处漂移。第一版正是这么写的，被 review 抓出来。
PRODUCT_DIMENSION_KEY = {
    ".claude/skills/daily-report-summary/reference/report-template-html.html": "template",
    ".claude/skills/weekly-update-summary/reference/report-template-html.html": "template",
    ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py": "archive",
}


def load_registered_dimensions():
    """解析规则 §1.4 的尺寸表，返回 {key: {desktop, mobile, top, right}}。

    解析不出来必须**显式判红**，不能回退到内置默认值——一旦有默认值兜底，
    表格被改坏时守卫会拿着过时的数字继续判绿，比没有守卫更糟。
    """
    path = ROOT / RULE_DOC
    if not path.is_file():
        fail(f"设计系统规则不存在：{RULE_DOC}")
        return None
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue
        m_key = re.fullmatch(r"`([a-z]+)`", cells[1])
        m_desk = re.fullmatch(r"(\d+)px", cells[2])
        m_mob = re.fullmatch(r"(\d+)px", cells[3])
        m_off = re.search(r"top:(-?\d+)px;\s*right:(-?\d+)px", cells[4])
        if not (m_key and m_desk and m_mob and m_off):
            continue
        out[m_key.group(1)] = {
            "desktop": int(m_desk.group(1)),
            "mobile": int(m_mob.group(1)),
            "top": int(m_off.group(1)),
            "right": int(m_off.group(2)),
        }
    missing = set(PRODUCT_DIMENSION_KEY.values()) - set(out)
    if missing:
        fail(f"规则 {RULE_DOC} §1.4 尺寸表里解析不到 key {sorted(missing)}——"
             f"表格结构或 key 变了？守卫拒绝用内置默认值兜底")
        return None
    return out

_REPORTED = object()          # px() 的哨兵：该项已单独报过，调用方不要重复叠报
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


def _media_block_spans(text):
    """返回所有 @media 块的 [起, 止) 区间，靠**花括号配对**判定，不靠行首前缀。

    不能只看规则所在行有没有 @media：验收生成器里 `@media(max-width:640px){{` 和
    `.masthead .emblem{{...}}` 分处两行，按行判会把响应式规则误认成基础规则，
    于是层叠顺序检查直接跳过——守卫对它声称要防的那个退化完全失明。

    这些 CSS 有两种写法：模板是纯 CSS（单花括号），生成器在 f-string 里（双花括号）。
    统一按「遇到 { 深度加一、遇到 } 深度减一」扫，两种都能配对（`{{` 相当于连加两次、
    `}}` 连减两次，深度归零的位置一致）。
    """
    spans = []
    for m in re.finditer(r'@media[^{]*', text):
        i = m.end()
        # 跳到块的第一个 {
        while i < len(text) and text[i] != "{":
            i += 1
        if i >= len(text):
            continue
        depth, j = 0, i
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        spans.append((m.start(), j + 1))
    return spans


def check_flavor_wiring():
    """真的把两种 flavor 渲染出来，断言各自戴对刊徽。

    为什么必须渲染而不能只扫源码：验收与巡检共用一个生成器文件，
    「文件里同时出现 polaris 和 comet」只证明两个常量都在，不证明**映射对**——
    把 _FLAVORS 里两者对调、或给两个 flavor 赋同一个常量（另一个声明变成死代码），
    源码扫描全绿，而生成出来的报告戴错徽。这正是
    predicate-and-wiring-discipline.md 形状 2：建到一半的接线，删掉不会红。
    """
    import importlib.util

    rel = ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"
    path = ROOT / rel
    if not path.is_file():
        fail(f"验收生成器不存在：{rel}")
        return
    spec = importlib.util.spec_from_file_location("archive_report_for_emblem_guard", path)
    mod = importlib.util.module_from_spec(spec)
    saved_argv, sys.argv = sys.argv, ["archive_report"]
    try:
        spec.loader.exec_module(mod)
    except Exception as e:                      # 导入失败要显式红，不能静默跳过
        fail(f"无法导入验收生成器做渲染验证：{type(e).__name__}: {e}")
        return
    finally:
        sys.argv = saved_argv

    md = "# 刊徽接线自测\n\n## 目标\n验证 flavor 与刊徽的映射。\n\n## 结论\n通过。\n"
    for flavor, want in (("acceptance", "polaris"), ("daily", "comet")):
        try:
            out = mod.build_interactive_html(
                title="刊徽接线自测", verdict="pass",
                markdown_content=md, manifest=[], flavor=flavor)
        except Exception as e:
            fail(f"flavor={flavor} 渲染失败：{type(e).__name__}: {e}")
            continue
        if out.count(f'data-emblem="{want}"') != 1:
            n = out.count('data-emblem="%s"' % want)
            fail(f"flavor={flavor} 渲染出的报告里 {want} 出现 {n} 次，应为 1 次"
                 f"——_FLAVORS 的刊徽映射接错了")
        for other in ALL_KINDS - {want}:
            if f'data-emblem="{other}"' in out:
                fail(f"flavor={flavor} 渲染出的报告戴了 {other}，应为 {want}"
                     f"——_FLAVORS 里两个 flavor 的刊徽很可能对调了")


def cascade_value(bodies, prop):
    """返回 (层叠胜者, 该层全部声明值)。**这是本守卫唯一的取值口径。**

    CSS 同特异性下后写的赢，所以判据必须取最后一条；取第一条会让守卫读到的值
    和浏览器渲染用的值不是同一个。本文件里尺寸与定位两处都栽过这个形状
    （第五轮、第七轮），故收成一个函数——判据分裂成两份就会各自漂移
    （predicate-and-wiring-discipline 形状 3）。
    """
    found = []
    for b in bodies:
        for m in re.finditer(r"(?:^|;)%s:([^;]+)" % re.escape(prop), b):
            found.append(m.group(1).strip())
    return (found[-1] if found else None), found


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

    media_spans = _media_block_spans(text)

    # 取出所有选择器含 .emblem 的规则块（`{` 或 f-string 里的 `{{` 都认），
    # 排除 `.emblem svg` 这种只管内部 svg 尺寸的从属规则。
    # 记下每条规则的位置与「是否在 @media 里」，用于下面的层叠顺序检查。
    rules = []
    for m in re.finditer(r'([^{};\n]*\.emblem[^{};\n]*)\{\{?([^}]*)\}', text):
        selector, body = m.group(1), m.group(2)
        if "svg" in selector:
            continue
        pos = m.start()
        rules.append({
            "pos": pos,
            "body": re.sub(r"\s+", "", body),
            "in_media": any(a <= pos < b for a, b in media_spans),
        })
    bodies = [r["body"] for r in rules]

    if not bodies:
        fail(f"{label}({rel}): 找不到 .emblem 的 CSS 规则——刊徽没有样式，"
             f"会当成普通块元素挤进报头 flex 流")
        return

    # 定位类声明必须同时具备这两条，否则它不是「水印」而是「遮挡物」。
    # 判据取**层叠胜者**而不是「某条规则里出现过」：`any(needle in b ...)` 的写法下，
    # 在合法规则之后追加一条 `.emblem{position:static;pointer-events:auto}`，
    # 刊徽重新挤回 flex 流并开始拦鼠标，而守卫全绿——和尺寸校验栽过的是同一个形状
    # （判据取的值 ≠ 真正生效的值）。第五轮只修了尺寸那一处，没有横扫同文件的同类判据，
    # 于是第七轮在这里原样复发：修的是实例，不是那一类。
    # z-index 同属这份契约：板式叫「衬字水印」，靠 z-index:0 垫在 .t/.r/.stamp（z-index:1）
    # 之下。它一旦漂成 1 以上，刊徽就从「衬底」变成「盖住刊名」，而前两条依然成立。
    # 既然这一轮的教训是「修的是类不是实例」，就把同一份契约的属性一次列全。
    for prop, want, why in (
        ("position", "absolute", "水印必须绝对定位，否则会挤进报头 flex 流把版面撑歪"),
        ("pointer-events", "none", "水印压在文字上层会挡住选中/点击"),
        ("z-index", "0", "衬字水印必须垫在刊名/期号之下，抬上去就成了盖住报头的贴纸"),
    ):
        winner, declared = cascade_value(bodies, prop)
        if winner is None:
            fail(f"{label}({rel}): .emblem 规则里没有 {prop} —— {why}")
        elif winner != want:
            fail(f"{label}({rel}): .emblem 的 {prop} 层叠胜者是 {winner!r}，应为 {want!r}"
                 f"（声明依次为 {declared}）—— {why}")
        elif len(set(declared)) > 1:
            fail(f"{label}({rel}): .emblem 对 {prop} 有互相打架的声明 {declared}"
                 f"——实际生效的是最后一条，这种写法请合并成一条")

    # 透明度必须真的「浅」，而且必须**显式写出来**。
    # 只判「写了但过高」是不够的：整条 opacity 声明被删掉时 CSS 默认 opacity:1，
    # 刊徽变成完全不透明的遮挡物盖住报头——正是本守卫号称要防的退化之一，
    # 而 re.search 返回 None 会让循环一声不吭地放行（本守卫第一版就是这个洞）。
    opacities = [float(mo.group(1))
                 for b in bodies
                 if (mo := re.search(r"opacity:([0-9.]+)", b))]
    if not opacities:
        fail(f"{label}({rel}): .emblem 没有任何 opacity 声明——"
             f"CSS 会默认 opacity:1，刊徽变成不透明遮挡物盖住报头（约定 ≈0.13）")
    for v in opacities:
        if not (0 < v <= 0.3):
            fail(f"{label}({rel}): .emblem 的 opacity={v} 不在 (0, 0.3] 内，"
                 f"过高会盖住报头文字、为 0 则等于没有刊徽（约定 ≈0.13）")

    # 层叠顺序：@media 覆盖必须排在基础规则**之后**。
    # 两者选择器特异性相同，靠源码顺序决胜——媒体查询若写在前面，
    # 后面的基础规则会把它整条盖掉，窄屏拿到的仍是桌面尺寸。
    # 这种错编译不报、桌面端看不出来，只有真机窄屏才暴露（日报模板首版即如此）。
    base_rules = [r for r in rules if not r["in_media"]]
    media_rules = [r for r in rules if r["in_media"]]
    base_pos = [r["pos"] for r in base_rules]
    media_pos = [r["pos"] for r in media_rules]
    if base_pos and media_pos and min(media_pos) < max(base_pos):
        fail(f"{label}({rel}): .emblem 的 @media 覆盖写在基础规则之前——"
             f"同特异性下会被后面的基础规则整条盖掉，窄屏仍是桌面尺寸")

    check_dimensions(label, rel, base_rules, media_rules)


def check_dimensions(label, rel, base_rules, media_rules):
    """尺寸与偏移必须与设计系统规则登记的一致。

    规则 §1.4 逐产物写死了桌面/窄屏尺寸与偏移；不校验的话那张表就只是散文，
    实现悄悄改了没人知道，四刊摆在一起就会看出参差——而这恰恰是本 PR 要解决的
    「四刊分不出来」的反面：分得出来但对不齐。
    """
    if REGISTERED is None:
        return                              # 规则表解析失败已单独判红，此处不重复刷屏
    dim_key = PRODUCT_DIMENSION_KEY.get(rel)
    if not dim_key:
        fail(f"{label}({rel}): 未在 PRODUCT_DIMENSION_KEY 登记——"
             f"新增产物时必须映射到规则 §1.4 的某个 key，否则水印大小可以随意漂")
        return
    want = REGISTERED[dim_key]

    def px(bodies, prop, where):
        """走统一的 cascade_value 取层叠胜者，并拒收互相打架的重复声明。

        同层出现互相打架的值，即便胜者恰好正确也判红：这种写法下「实际生效的是哪个」
        要靠读者自己推层叠，是后续漂移的温床。
        """
        winner, declared = cascade_value(bodies, prop)
        if winner is None:
            return None
        nums = []
        for v in declared:
            m = re.fullmatch(r"(-?[0-9.]+)px", v)
            if not m:
                fail(f"{label}({rel}): {where}的 .emblem 里 {prop}:{v} 不是 px 值——"
                     f"规则 §1.4 登记的是像素尺寸，非 px 写法无法与之比对")
                return _REPORTED           # 已报过，别再叠一条「没有该属性」
            nums.append(float(m.group(1)))
        if len(set(nums)) > 1:
            fail(f"{label}({rel}): {where}的 .emblem 对 {prop} 有互相打架的声明 {nums}"
                 f"——实际生效的是最后一条（{nums[-1]:g}px），这种写法请合并成一条")
        return nums[-1]

    base = [r["body"] for r in base_rules]
    media = [r["body"] for r in media_rules]

    # width 与 height 都要查：刊徽 viewBox 是正方形，两者不等会把水印拉扁或压瘦，
    # 只查 width 的话 height 可以悄悄漂走（第一版就漏了 height）。
    for prop, key, where, bodies in (
        ("width", "desktop", "桌面", base),
        ("height", "desktop", "桌面", base),
        ("top", "top", "桌面", base),
        ("right", "right", "桌面", base),
        ("width", "mobile", "窄屏", media),
        ("height", "mobile", "窄屏", media),
    ):
        got = px(bodies, prop, where)
        if got is _REPORTED:
            continue
        if got is None:
            fail(f"{label}({rel}): {where}的 .emblem 规则里没有 {prop} —— "
                 f"规则 §1.4（key={dim_key}）登记的是 {want[key]}px")
        elif got != want[key]:
            fail(f"{label}({rel}): {where} {prop}={got:g}px，"
                 f"与规则 §1.4（key={dim_key}）登记的 {want[key]}px 不符——"
                 f"尺寸唯一来源是规则表，改实现请先改表")


CI_WORKFLOW = ".github/workflows/ci.yml"
CI_FILTER_NAME = "release_scripts"


def _glob_to_regex(pat):
    """把 paths-filter 的 glob 转成正则。`**` 跨目录，`*`/`?` 不跨 `/`。"""
    out, i = [], 0
    while i < len(pat):
        c = pat[i]
        if pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def check_ci_wiring():
    """本守卫的每个**输入文件**都必须登记进 CI 那道闸的 path filter。

    「测试被 workflow 引用」只是必要条件。release-script-test 有 path filter，
    filter 里若只有 `scripts/tests/test_*.py` 而没有被测的模板与规则文档，
    那这道闸就只在「守卫自己被改」时开——而漂移恰恰发生在被测文件那边：
    一个只改模板的 PR 可以引入本守卫存在的意义所要拒绝的那种漂移，
    而所有必需检查全绿（predicate-and-wiring-discipline 形状 2 的递归形态：
    防漂移的工具自己没接上线）。

    有了这一条，日后加第五刊时忘了改 ci.yml 会当场红，而不是静默失去覆盖。
    """
    path = ROOT / CI_WORKFLOW
    if not path.is_file():
        fail(f"找不到 {CI_WORKFLOW}，无法确认守卫是否真被 CI 触发")
        return
    lines = path.read_text(encoding="utf-8").splitlines()

    # 截出 `release_scripts:` 这一段的 `- '...'` 条目（下一个同缩进的 key 为界）
    pats, indent = [], None
    for line in lines:
        if indent is None:
            m = re.match(r"^(\s*)%s:\s*$" % re.escape(CI_FILTER_NAME), line)
            if m:
                indent = len(m.group(1))
            continue
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        cur = len(line) - len(line.lstrip())
        if cur <= indent and not line.lstrip().startswith("-"):
            break                                   # 到下一个 filter 了
        m = re.match(r"^\s*-\s*['\"]?([^'\"]+)['\"]?\s*$", line)
        if m:
            pats.append(m.group(1).strip())
    if indent is None or not pats:
        fail(f"{CI_WORKFLOW} 里解析不到 {CI_FILTER_NAME} 的 path filter——"
             f"结构变了？守卫拒绝在无法确认触发条件的情况下判绿")
        return

    regexes = [_glob_to_regex(p) for p in pats]
    watched = [RULE_DOC] + [rel for _, rel, _ in EXPECTED]
    for rel in watched:
        if not any(r.match(rel) for r in regexes):
            fail(f"{rel} 没有登记进 {CI_WORKFLOW} 的 {CI_FILTER_NAME} filter——"
                 f"只改这个文件的 PR 不会触发本守卫，漂移会一路绿灯合进来")


print("米多刊系刊徽守卫")
print("-" * 60)
# 尺寸来自规则表，不在本文件另存副本
REGISTERED = load_registered_dimensions()
if REGISTERED:
    print(f"已从 {RULE_DOC} §1.4 读到尺寸登记：{REGISTERED}")
for label, rel, kinds in EXPECTED:
    print(f"检查 {label}: {rel}")
    check_file(label, rel, kinds)

print("渲染验证：两种 flavor 各自戴对刊徽")
check_flavor_wiring()

# 三处的水印都必须是「绝对定位 + 低透明度 + 不吃鼠标」，否则不是水印而是遮挡物
for label, rel in [
    ("日报", ".claude/skills/daily-report-summary/reference/report-template-html.html"),
    ("周报", ".claude/skills/weekly-update-summary/reference/report-template-html.html"),
    ("验收/巡检", ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"),
]:
    check_css_wiring(label, rel)

print("CI 触发验证：被测文件都登记进了 release-script-test 的 path filter")
check_ci_wiring()

print("-" * 60)
if failures:
    print(f"刊徽守卫未通过：{len(failures)} 项")
    sys.exit(1)
print(f"刊徽守卫通过（{len(EXPECTED)} 个产物 / {sum(len(k) for _, _, k in EXPECTED)} 枚刊徽）")
