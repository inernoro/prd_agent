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
import types

ROOT = pathlib.Path(__file__).resolve().parents[2]

# data-emblem 属性的发现正则。**按 HTML 属性语法穷举，而不是按我想得到的写法枚举。**
#
# 这条正则被连着指出收窄过三次，每次都是一个我没想到的合法维度：
#   第 12 轮 值的字符集 `([a-z]+)`      -> 漏 asteroid-2 / Moon
#   第 13 轮 引号种类只认 `"`           -> 漏 data-emblem='x'
#   第 14 轮 等号两侧不许空白           -> 漏 data-emblem = "x"
# 每次我修完都以为「这条正则对了」，因为修的是**被指出的那一个**维度。
# 第 14 轮修完我回头把 HTML 属性语法本身过了一遍，自己找到第四个：**无引号值**
# （`data-emblem=asteroid2` 同样合法），确认仍然漏。
#
# 所以现在按语法穷举三种形式：双引号 / 单引号 / 无引号（值不含空白与 " \' ` = < >）。
# 这是 HTML 属性值的全部合法写法，不再是「我想到的那几种」。
EMBLEM_ATTR_RE = re.compile(
    r"""data-emblem\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))""")


def emblem_value(m):
    """从 EMBLEM_ATTR_RE 的 match 取属性值（三种写法命中哪个组取哪个）。"""
    return next(g for g in m.groups() if g is not None)

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
        # 窄屏偏移与桌面偏移是两档独立登记：刊徽变小时压进报头的量也要跟着变小。
        # 只登记桌面档等于窄屏可以随便漂——把档案窄屏 right 从 -2px 改成 -200px
        # 刊徽会整个移出屏幕，而只查桌面偏移的守卫照样判绿（review 实测）。
        m_moff = re.search(r"top:(-?\d+)px;\s*right:(-?\d+)px", cells[5]) if len(cells) > 5 else None
        if not (m_key and m_desk and m_mob and m_off and m_moff):
            continue
        out[m_key.group(1)] = {
            "desktop": int(m_desk.group(1)),
            "mobile": int(m_mob.group(1)),
            "top": int(m_off.group(1)),
            "right": int(m_off.group(2)),
            "mobile_top": int(m_moff.group(1)),
            "mobile_right": int(m_moff.group(2)),
        }
    missing = set(PRODUCT_DIMENSION_KEY.values()) - set(out)
    if missing:
        fail(f"规则 {RULE_DOC} §1.4 尺寸表里解析不到 key {sorted(missing)}——"
             f"表格结构或 key 变了？守卫拒绝用内置默认值兜底")
        return None
    return out

# 哪些产物已经做过「刊徽长在报头里」的判定。收尾时比对 EXPECTED，
# 防止某个产物两条路径都没覆盖到却静默判绿（形状 2：建到一半的接线）。
_MASTHEAD_CHECKED = set()

_REPORTED = object()          # px() 的哨兵：该项已单独报过，调用方不要重复叠报
failures = []


def fail(msg):
    failures.append(msg)
    print(f"  [FAIL] {msg}")


def count_emblem(text, kind):
    """数某枚刊徽出现次数——同样两种引号都认，不能用 f'data-emblem="{kind}"' 硬拼。"""
    return sum(1 for m in EMBLEM_ATTR_RE.finditer(text) if emblem_value(m) == kind)


def check_file(label, rel, expected_kinds):
    path = ROOT / rel
    if not path.is_file():
        fail(f"{label}: 产物文件不存在 {rel}")
        return
    text = path.read_text(encoding="utf-8")

    # 捕获**整个属性值**，不能写成 `([a-z]+)`：那样 data-emblem="asteroid-2" 这类
    # 合法但不在注册表里的值根本进不了 found，混装判定与 SVG 完整性检查都看不到它——
    # 报告上多一枚完全不受检的水印而守卫全绿。上一轮把「先与 ALL_KINDS 求交」去掉了，
    # 却没发现**发现环节本身**还在窄化：集合在源头就少了元素，后面判得再宽也没用。
    found = set(emblem_value(m) for m in EMBLEM_ATTR_RE.finditer(text))

    missing = expected_kinds - found
    if missing:
        fail(f"{label}({rel}): 缺刊徽 {sorted(missing)}——该刊物的报头会没有水印")

    # 混装：装了别的刊物的徽 = 读者会把这一刊认成另一刊，比没有更糟。
    # 判据**不能先与 ALL_KINDS 求交**：那样一枚未注册的 data-emblem="asteroid"
    # 会被交集直接滤掉，既不进 wrong、下面的完整性循环也不看它——
    # 报告上多出一枚不受任何检查的水印而守卫全绿。契约是「有且只有它自己那枚」，
    # 所以直接拿发现的全集比对期望集（形状 1：判据比它该管的范围窄）。
    wrong = found - expected_kinds
    if wrong:
        fail(f"{label}({rel}): 混入了不属于它的刊徽 {sorted(wrong)}"
             f"（应为 {sorted(expected_kinds)}）——"
             f"{'未在刊系注册表登记的刊徽，' if wrong - ALL_KINDS else ''}"
             f"会多出一枚不受检的水印或把这一刊错认成另一刊")

    # 每枚只该出现一次；重复会导致 SVG 内部 id 撞车，后一份引用到前一份的 mask
    for kind in expected_kinds:
        n = count_emblem(text, kind)
        if n > 1:
            fail(f"{label}({rel}): 刊徽 {kind} 出现 {n} 次——"
                 f"SVG 内部 id 会撞车，第二枚会引用到第一枚的 mask/clip")

    # 同理，完整性检查也扫全集而不是交集——未注册的那一枚同样会被渲染出来，
    # 它的 mask/clipPath 引用坏掉、id 撞车、引外部资源，一样会影响这份报告。
    for kind in sorted(found):
        check_svg_integrity(label, rel, kind, text)

    # 报头归属只能在**真正的标记文本**上判：模板文件本身就是标记，直接查；
    # 验收生成器的 SVG 存在模块级常量里、靠 `{emblem_svg}` 注入报头，源码里那份常量
    # 天然不在 masthead 内——对它做源码级判定必然误报（我的第一版就这么写，基线直接变红），
    # 得查渲染产物（由 check_flavor_wiring 渲染两种 flavor 后各查一次）。
    if rel.endswith(".html"):
        check_emblem_in_masthead(label, rel, text, expected_kinds)
        _MASTHEAD_CHECKED.add(rel)


def _close_at(text, m):
    """给定一个开标签的 match，按同名标签配对计数返回该元素的 [起, 止)。

    不能简单找下一个 `</div>`——元素里嵌了同名标签就会截错（报头里正好嵌着若干 div）。
    配不上对返回 None，交给调用方显式判红，不静默当成「没问题」。
    """
    tag = m.group(1)
    depth, i = 1, m.end()
    pat = re.compile(r'</?%s\b' % tag)
    while depth and (nxt := pat.search(text, i)):
        depth += -1 if nxt.group(0).startswith("</") else 1
        i = nxt.end()
    return (m.start(), i) if depth == 0 else None


def _masthead_block(text):
    """截出报头那一段（`<header class="masthead">` 或 `<div class="masthead">` 到其闭合标签）。

    两种产物的标签名不同（模板用 header，验收生成器用 div），故走同名标签配对。
    """
    m = re.search(r'<(header|div)\b[^>]*class="[^"]*\bmasthead\b[^"]*"[^>]*>', text)
    if not m:
        return None
    span = _close_at(text, m)
    return text[span[0]:span[1]] if span else None


def _emblem_spans(block):
    """返回报头内所有 `.emblem` 包裹元素的 [起, 止) 区间（相对 block）。"""
    spans = []
    for m in re.finditer(r'<(div|span)\b[^>]*class="[^"]*\bemblem\b[^"]*"[^>]*>', block):
        span = _close_at(block, m)
        if span:
            spans.append(span)
    return spans


def check_emblem_in_masthead(label, rel, text, expected_kinds):
    """刊徽必须**长在报头里**，不只是「文件里某处有」。

    `data-emblem` 在整个文件里搜得到，不代表它挂在 `.masthead` 下：把那个 div 搬到
    报头外面，模板的绝对定位会改为相对别的祖先解析（水印跑到页面别处），
    验收生成器更彻底——它的选择器是 `.masthead .emblem`，搬出去后整条样式直接不生效，
    刊徽变成一个 120px 的实心块挤进正文。而只按全文匹配的判据对这两种都判绿。

    这与「只查 .emblem 自己的声明、不查它成立所依赖的上下文」是同一个形状：
    判据比它该管的范围窄（形状 1）。
    """
    block = _masthead_block(text)
    if block is None:
        fail(f"{label}({rel}): 找不到成对的 masthead 报头标签——"
             f"结构变了？守卫无法确认刊徽是否长在报头里")
        return
    # 报头内的 `.emblem` 包裹元素区间。所有 CSS（定位/尺寸/透明度/层级）都挂在
    # `.emblem` 上，SVG 本身一条样式都没有——所以「在报头里」还不够，必须**在包裹元素里**。
    # 只比对报头计数的话，把 SVG 从 wrapper 里挪出来当报头的兄弟节点，
    # `n_head == n_all` 依然成立、守卫照样绿，而 SVG 会退化成 120x120 的文档流 flex
    # 子项把报头撑歪。上一轮我只把范围收到「报头」，还差一层。
    spans = _emblem_spans(block)
    for kind in sorted(expected_kinds):
        n_all = count_emblem(text, kind)
        n_head = count_emblem(block, kind)
        if n_head != n_all:
            fail(f"{label}({rel}): 刊徽 {kind} 有 {n_all - n_head} 处不在 masthead 报头内——"
                 f"搬出报头后绝对定位会相对别的祖先解析（模板），"
                 f"或 `.masthead .emblem` 选择器整条失效（验收生成器）")
            continue
        n_wrap = sum(count_emblem(block[a:b], kind) for a, b in spans)
        if n_wrap != n_all:
            fail(f"{label}({rel}): 刊徽 {kind} 有 {n_all - n_wrap} 处虽在报头内、"
                 f"但不在 `.emblem` 包裹元素里——SVG 自身没有任何样式，"
                 f"脱离 wrapper 后会退化成 120x120 的文档流 flex 子项把报头撑歪")


def check_svg_integrity(label, rel, kind, text):
    """截出该刊徽的 SVG 片段，验证 id 引用能解析、且不引外部资源。

    为什么要查 id：mask/clipPath 引不到就渲染成空白或整块实心——
    页面不报错，肉眼在 0.13 透明度下也未必看得出，属于典型的静默失效。
    """
    k = re.escape(kind)
    m = re.search(r'<svg[^>]*data-emblem\s*=\s*(?:"%s"|\'%s\'|%s(?=[\s/>])).*?</svg>'
                  % (k, k, k), text, re.S)
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
    rel = ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"
    path = ROOT / rel
    if not path.is_file():
        fail(f"验收生成器不存在：{rel}")
        return
    # **直接编译执行盘上的源码文本**，完全绕开字节码缓存。
    #
    # 为什么不能走 importlib 的 exec_module：.pyc 的有效性按 (源码 mtime 秒, 文件大小)
    # 判定，而「把一处标记改成等长的另一种写法」恰好两项都不变，缓存被认定有效。
    # 上一轮我以为置 sys.dont_write_bytecode 就够了——那只挡住**写**，挡不住**读**：
    # 只要之前有进程留下过合法 .pyc，exec_module 照样会加载它，守卫验的就成了
    # 上一次的旧代码而不是盘上这份。（我上一轮之所以以为修好了，是因为验证前先清了
    # 缓存，根本没有旧 .pyc 可读——测试方向与缺陷方向重合，照不出洞。）
    src = path.read_text(encoding="utf-8")
    mod = types.ModuleType("archive_report_for_emblem_guard")
    mod.__file__ = str(path)
    saved_argv, sys.argv = sys.argv, ["archive_report"]
    try:
        exec(compile(src, str(path), "exec"), mod.__dict__)
    except Exception as e:                      # 导入失败要显式红，不能静默跳过
        fail(f"无法加载验收生成器做渲染验证：{type(e).__name__}: {e}")
        return
    finally:
        sys.argv = saved_argv

    label = "验收/巡检"
    md = "# 刊徽接线自测\n\n## 目标\n验证 flavor 与刊徽的映射。\n\n## 结论\n通过。\n"
    for flavor, want in (("acceptance", "polaris"), ("daily", "comet")):
        try:
            out = mod.build_interactive_html(
                title="刊徽接线自测", verdict="pass",
                markdown_content=md, manifest=[], flavor=flavor)
        except Exception as e:
            fail(f"flavor={flavor} 渲染失败：{type(e).__name__}: {e}")
            continue
        if count_emblem(out, want) != 1:
            n = count_emblem(out, want)
            fail(f"flavor={flavor} 渲染出的报告里 {want} 出现 {n} 次，应为 1 次"
                 f"——_FLAVORS 的刊徽映射接错了")
        for other in ALL_KINDS - {want}:
            if count_emblem(out, other):
                fail(f"flavor={flavor} 渲染出的报告戴了 {other}，应为 {want}"
                     f"——_FLAVORS 里两个 flavor 的刊徽很可能对调了")
        # 报头归属查渲染产物：源码里那份 SVG 常量本就不在 masthead 内，
        # 只有注入之后的标记才能回答「它到底挂在哪」。
        check_emblem_in_masthead(f"{label}(flavor={flavor})", rel, out, {want})
        _MASTHEAD_CHECKED.add(rel)


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


def selector_targets(sel, cls, must_mention=None):
    """这条选择器是否**以 `.cls` 为目标元素**（即最后一段复合选择器含该类）。

    只看最后一段：`.masthead .t` 的目标是 `.t` 不是 `.masthead`；
    `.emblem svg` 的目标是 svg，不该被当成 `.emblem` 的规则。
    反过来 `header.masthead`、`.paper .emblem` 的目标就是 masthead / emblem。

    must_mention 用于前景那种「限定在报头内」的契约：要求整串里出现该词，
    这样 `header.masthead .t`（更特异）会被收进来，而与报头无关的同名 `.t` 不会。
    """
    sel = sel.strip()
    if not sel:
        return False
    if must_mention and must_mention not in sel:
        return False
    last = re.split(r'[\s>+~]+', sel)[-1]
    return re.search(r'\.%s(?![\w-])' % re.escape(cls), last) is not None


def rules_targeting(text, cls, must_mention=None):
    """收集**所有以 `.cls` 为目标**的规则（含更特异的写法），按源码顺序返回。

    为什么不能只认字面等于 `.cls` 的选择器：CSS 的胜者由**特异性**先于源码顺序决定，
    在 `.masthead` 之前插一条 `header.masthead{position:static}`，浏览器用 static，
    而只认字面 `.masthead` 的判据根本看不见这条规则（review 实测判绿）。

    本守卫**不实现特异性计算**——那等于在测试里重写一个 CSS 引擎，是新的漂移源。
    改用更强的契约：凡是能命中这个元素的规则，其声明**都必须**满足约定值。
    这比 CSS 语义严格（合法的同值重复写法也会被要求一致），但换来的是判据不会因为
    有人换个更特异的写法就失明——对守卫来说这个取舍是划算的。
    """
    out = []
    # 规则体用 `[^{}]*`（不含左花括号）而不是 `[^}]*`：后者会把
    # `@media (...) { .emblem { ... } }` 整条当成一个「选择器=@media、体=里面全部」的
    # 匹配吞掉，嵌套在里面的 .emblem 规则再也匹配不到——窄屏那一档会整个消失。
    for m in re.finditer(r'([^{};\n]*)\{\{?([^{}]*)\}', text):
        if any(selector_targets(part, cls, must_mention) for part in m.group(1).split(",")):
            out.append({"pos": m.start(),
                        "body": re.sub(r"\s+", "", m.group(2)),
                        "sel": m.group(1).strip()})
    return out


def require_all_declarations(label, rel, rules, prop, ok, why):
    """该元素**每一条**匹配规则里的 prop 声明都必须满足 ok()，否则判红。

    取「全部」而不是「层叠胜者」，是上面那个取舍的落地：不用算特异性也不会漏。
    """
    seen = False
    for r in rules:
        _, declared = cascade_value([r["body"]], prop)
        for v in declared:
            seen = True
            if not ok(v):
                fail(f"{label}({rel}): 规则 `{r['sel']}` 把 {prop} 声明成 {v!r}——{why}")
    return seen


# 报头里必须画在刊徽**之上**的前景元素。衬字水印是「刊徽 z-index:0 垫底 +
# 这些前景元素 position:relative;z-index:1 提到上层」两半合起来才成立的：
# 删掉前景那一半，已定位的 level-0 刊徽就会盖过普通文档流里的报头内容。
# 第七轮我说「把同一份契约的属性一次列全」，列的却只有 .emblem 自己那半。
FOREGROUND_CLASSES = ("t", "r", "stamp")

# 能在不写出契约长属性名的情况下把契约推翻的简写/逻辑属性。
# 判据是按属性名精确取值的，这些写法根本不进那条正则：
#   `.emblem{inset:0}`      -> 桌面 top/right 变 0，刊徽跑到报头左上角
#   `.emblem{all:initial}`  -> 定位/层级/透明度/尺寸整份契约一起没了
#   `inline-size/block-size` -> width/height 的逻辑属性别名
# 与第 13 轮同样的取舍：不展开简写（那要实现 CSS 的简写展开表，又一个引擎），
# 直接**拒收**——契约元素上本来也没有正当理由写这些。
CONTRACT_SHORTHANDS = re.compile(
    r"^(all|inset(-block|-inline)?(-start|-end)?|inline-size|block-size)$")


def reject_contract_shorthands(label, rel, rules, what):
    """契约元素的规则里不许出现能绕过长属性判据的简写。"""
    for r in rules:
        for m in re.finditer(r"(?:^|;)([a-z-]+):", r["body"]):
            prop = m.group(1)
            if CONTRACT_SHORTHANDS.match(prop):
                fail(f"{label}({rel}): 规则 `{r['sel']}` 用了简写/逻辑属性 {prop!r}——"
                     f"它能在不写出长属性名的情况下推翻{what}的契约"
                     f"（inset 改 top/right、all 重置全部、*-size 顶替 width/height），"
                     f"判据按长属性名取值看不见它。请改写成明确的长属性。")


POSITIONED = ("relative", "absolute", "fixed", "sticky")


def check_foreground_stacking(label, rel, text):
    """前景元素必须已定位且层级高于刊徽，否则「衬字」这个板式根本不成立。

    同样收集所有以该类为目标、且选择器提到 masthead 的规则——这样
    `header.masthead .t` 这类更特异的覆盖会被收进来，而与报头无关的同名 `.t` 不会。
    """
    for cls in FOREGROUND_CLASSES:
        rules = rules_targeting(text, cls, must_mention="masthead")
        if not rules:
            fail(f"{label}({rel}): 找不到报头内 `.{cls}` 的 CSS 规则——"
                 f"报头前景没有被提到刊徽之上，水印会盖住刊名/期号")
            continue
        reject_contract_shorthands(label, rel, rules, f"报头前景 `.{cls}`")
        seen_pos = require_all_declarations(
            label, rel, rules, "position",
            lambda v: v in POSITIONED,
            f"报头前景 `.{cls}` 必须已定位，未定位元素的 z-index 不生效，刊徽会画到报头文字之上")
        if not seen_pos:
            fail(f"{label}({rel}): 报头前景 `.{cls}` 没有 position 声明——"
                 f"未定位元素的 z-index 不生效，刊徽会画到报头文字之上")
        seen_z = require_all_declarations(
            label, rel, rules, "z-index",
            lambda v: bool(re.fullmatch(r"-?\d+", v)) and int(v) > 0,
            f"报头前景 `.{cls}` 的层级必须是整数且严格高于刊徽的 0，衬字水印才成立")
        if not seen_z:
            fail(f"{label}({rel}): 报头前景 `.{cls}` 没有 z-index 声明——"
                 f"衬字水印要求前景严格在刊徽之上")


def check_positioning_context(label, rel, text):
    """`.masthead` 必须是已定位祖先，否则刊徽的绝对偏移会锚到别的元素上。

    收集**所有以 masthead 为目标**的规则（含 `header.masthead` 这类更特异写法），
    并要求每一条的 position 声明都是已定位值——不算特异性，直接拒绝任何会让它
    退回 static 的写法（见 rules_targeting 的取舍说明）。
    """
    rules = rules_targeting(text, "masthead")
    if not rules:
        fail(f"{label}({rel}): 找不到以 `.masthead` 为目标的 CSS 规则——"
             f"刊徽的绝对定位没有可锚定的祖先")
        return
    reject_contract_shorthands(label, rel, rules, "报头定位上下文")
    seen = require_all_declarations(
        label, rel, rules, "position",
        lambda v: v in POSITIONED,
        "`.masthead` 必须是已定位元素，否则刊徽的 top/right 会相对页面级祖先解析，水印跑出报头")
    if not seen:
        fail(f"{label}({rel}): `.masthead` 没有任何 position 声明——"
             f"static 祖先不建立定位上下文，刊徽的 top/right 会相对页面级祖先解析")


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
    # 走统一的 rules_targeting：`.emblem svg` 因目标是 svg 被自动排除，
    # 而 `.paper .emblem` / `header.masthead .emblem` 这类更特异的覆盖会被收进来
    # （只认字面 `.emblem` 的旧写法看不见它们，等于对特异性覆盖失明）。
    rules = rules_targeting(text, "emblem")
    for r in rules:
        r["in_media"] = any(a <= r["pos"] < b for a, b in media_spans)
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
    reject_contract_shorthands(label, rel, rules, "刊徽水印")

    # 判据取「所有匹配规则的每一条声明都必须等于约定值」，而不是算层叠胜者：
    # 胜者由特异性先于源码顺序决定，算特异性等于在测试里重写 CSS 引擎（新的漂移源）。
    # 要求全体一致更严格，但换来「换个更特异的写法就失明」这一整类洞被堵死。
    for prop, want, why in (
        ("position", "absolute", "水印必须绝对定位，否则会挤进报头 flex 流把版面撑歪"),
        ("pointer-events", "none", "水印压在文字上层会挡住选中/点击"),
        ("z-index", "0", "衬字水印必须垫在刊名/期号之下，抬上去就成了盖住报头的贴纸"),
    ):
        seen = require_all_declarations(label, rel, rules, prop,
                                        lambda v, w=want: v == w, why)
        if not seen:
            fail(f"{label}({rel}): .emblem 规则里没有 {prop} —— {why}")

    # 定位祖先：`position:absolute` 的 top/right 是相对**最近的已定位祖先**解析的。
    # 只查 .emblem 自己的声明不够——把 `.masthead` 的 position:relative 拿掉，
    # 刊徽的 -14px/-8px 就会相对页面级祖先解析，水印跑到报头外面去，
    # 而只看 .emblem 的判据全绿。判据必须连它成立所依赖的上下文一起查（形状 1）。
    check_positioning_context(label, rel, text)
    check_foreground_stacking(label, rel, text)

    # 透明度必须真的「浅」，而且必须**显式写出来**。
    # 只判「写了但过高」是不够的：整条 opacity 声明被删掉时 CSS 默认 opacity:1，
    # 刊徽变成完全不透明的遮挡物盖住报头——正是本守卫号称要防的退化之一，
    # 而 re.search 返回 None 会让循环一声不吭地放行（本守卫第一版就是这个洞）。
    # 走统一的 cascade_value：不能自己再写一条 `re.search(r"opacity:([0-9.]+)")`，
    # 那个正则只认数字，遇到 `opacity: unset` 会**跳过这条声明**并保留前面那个合法的 0.13——
    # 而 unset 对这个非继承属性解析为初始值 1，刊徽变成完全不透明的遮挡物。
    # 上一轮我把 position/pointer-events/z-index/尺寸都收敛到 cascade_value 了，
    # 唯独漏了这一处，于是同一个形状第三次复发。**「横扫同类」要扫到最后一个，不是扫到手顺为止。**
    winner, declared = cascade_value(bodies, "opacity")
    if winner is None:
        fail(f"{label}({rel}): .emblem 没有任何 opacity 声明——"
             f"CSS 会默认 opacity:1，刊徽变成不透明遮挡物盖住报头（约定 ≈0.13）")
    else:
        for v in declared:
            if not re.fullmatch(r"[0-9.]+", v):
                fail(f"{label}({rel}): .emblem 的 opacity:{v} 不是数值——"
                     f"unset/initial/inherit 之类会解析成初始值 1（完全不透明），"
                     f"请写明确的小数（约定 ≈0.13）")
                continue
            if not (0 < float(v) <= 0.3):
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
        # 窄屏偏移必须一起查：三个产物在 @media 里都重写了 top/right，只查桌面档
        # 等于窄屏可以随便漂——把档案窄屏 right 改成 -200px 刊徽整个移出屏幕，
        # 而只查两档尺寸的守卫照样判绿（review 实测）。
        ("top", "mobile_top", "窄屏", media),
        ("right", "mobile_right", "窄屏", media),
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

# 报头归属两条路径（模板走源码、生成器走渲染产物）合起来必须覆盖全部产物，
# 否则某个产物会两边都没查到却静默判绿。
for _, _rel, _ in EXPECTED:
    if _rel not in _MASTHEAD_CHECKED:
        fail(f"{_rel} 没有做过「刊徽长在报头里」的判定——"
             f"新增产物时必须走模板源码或渲染产物两条路径之一")

print("-" * 60)
if failures:
    print(f"刊徽守卫未通过：{len(failures)} 项")
    sys.exit(1)
print(f"刊徽守卫通过（{len(EXPECTED)} 个产物 / {sum(len(k) for _, _, k in EXPECTED)} 枚刊徽）")
