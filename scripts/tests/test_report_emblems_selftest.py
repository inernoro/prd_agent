#!/usr/bin/env python3
"""刊徽守卫的**自测**：证明守卫真的会对每一种已知退化判红。

为什么需要这一层
----------------
`test_report_emblems.py` 回答「当前仓库是否合契约」。它判绿只说明**此刻没问题**，
不说明**守卫还有能力发现问题**——判据被改窄、接线被删掉、某条检查再也不执行，
它同样判绿。本 PR 的第 18 轮就真的发生了：一次重构把三个检查函数的调用点连同
一个函数定义一起删掉，守卫基线照样全绿，只有把前面每一轮的红绿用例重跑一遍
才暴露出来。

那次之所以能发现，靠的是我手工重跑了十几条历史用例。这一层就是把那件事固化：
每条用例 = 一种真实退化的最小复现，守卫**必须**对它判红。判据退化 -> 某条用例
从红变绿 -> 这里判红。

跑法：`python3 scripts/tests/test_report_emblems_selftest.py`
CI 通过 `for t in scripts/tests/test_*.py` 自动执行（与守卫本身同一道闸）。
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]

GUARD = "scripts/tests/test_report_emblems.py"
DAILY = ".claude/skills/daily-report-summary/reference/report-template-html.html"
WEEKLY = ".claude/skills/weekly-update-summary/reference/report-template-html.html"
ARCHIVE = ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"
RULE = ".claude/rules/report-design-system.md"
CI = ".github/workflows/ci.yml"

# 守卫运行所需的全部输入（它会读规则表、读 ci.yml 自查 path filter）
NEEDED = [GUARD, DAILY, WEEKLY, ARCHIVE, RULE, CI]


def sub_after(text, anchor, insert):
    """在 anchor 之后插入一段（用于往 CSS 里追加覆盖规则）。"""
    i = text.index(anchor) + len(anchor)
    return text[:i] + insert + text[i:]


def emblem_open_tag(text, replacement):
    """把刊徽包裹元素的开标签换成 replacement。"""
    return text.replace('<div class="emblem">', replacement, 1)


# 每条用例：(编号, 说明, 目标文件, 变换函数)
# 变换必须是**真实会发生的退化**，并且守卫必须判红。
CASES = [
    # ── 刊徽本体与归属 ──────────────────────────────────────────────
    ("R1-缺徽", "刊徽整个删掉", DAILY,
     lambda t: re.sub(r'<div class="emblem">.*?</div>\n', "", t, count=1, flags=re.S)),
    ("R6-flavor对调", "验收/巡检两枚刊徽映射对调", ARCHIVE,
     lambda t: t.replace('"emblem": _EMBLEM_POLARIS', '"emblem": _TMP')
                .replace('"emblem": _EMBLEM_COMET', '"emblem": _EMBLEM_POLARIS')
                .replace('"emblem": _TMP', '"emblem": _EMBLEM_COMET')),
    ("R8-混装未注册", "混入未在注册表登记的刊徽", DAILY,
     lambda t: t.replace('<div class="emblem"><svg ',
                         '<div class="emblem"><svg data-emblem="asteroid-2" ', 1)),
    ("R13-单引号混装", "未注册刊徽用单引号写", DAILY,
     lambda t: t.replace('<div class="emblem"><svg ',
                         "<div class=\"emblem\"><svg data-emblem='asteroid-2' ", 1)),
    ("R14-空格混装", "未注册刊徽等号两侧带空格", DAILY,
     lambda t: t.replace('<div class="emblem"><svg ',
                         '<div class="emblem"><svg data-emblem = "asteroid-2" ', 1)),
    ("R14-无引号混装", "未注册刊徽无引号写法", DAILY,
     lambda t: t.replace('<div class="emblem"><svg ',
                         '<div class="emblem"><svg data-emblem=asteroid2 ', 1)),
    ("R15-大写混装", "未注册刊徽属性名大写", DAILY,
     lambda t: t.replace('<div class="emblem"><svg ',
                         '<div class="emblem"><svg DATA-EMBLEM="asteroid-2" ', 1)),
    ("R17-注释掉", "刊徽被 HTML 注释包起来（浏览器不渲染）", DAILY,
     lambda t: re.sub(r'(<div class="emblem">.*?</div>)',
                      r"<!-- \1 -->", t, count=1, flags=re.S)),
    ("R11-脱离包裹", "SVG 挪出 .emblem 包裹元素但仍在报头内", DAILY,
     lambda t: re.sub(r'(<div class="emblem">)(<svg.*?</svg>)(</div>)',
                      r'\1\3\2', t, count=1, flags=re.S)),
    ("R16-class改名", "报头 class 改成 masthead-alt（CSS 全部失配）", DAILY,
     lambda t: t.replace('<header class="masthead">', '<header class="masthead-alt">', 1)),

    # ── 刊徽自身的 CSS 契约 ─────────────────────────────────────────
    ("R7-position", "刊徽退回文档流", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { position: static; ")),
    ("R7-pointer", "刊徽开始拦鼠标", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { pointer-events: auto; ")),
    ("R7-zindex", "刊徽层级抬到刊名之上", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { z-index: 2; ")),
    ("R8-opacity", "刊徽变完全不透明", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { opacity: 1; ")),
    ("R12-opacity非数值", "opacity: unset（解析为 1）", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { opacity: unset; ")),
    ("R17-display", "刊徽任何视口都不渲染", WEEKLY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { display: none; ")),
    ("R17-visibility", "刊徽不可见", WEEKLY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { visibility: hidden; ")),
    ("R14-简写inset", "inset 简写绕过 top/right 判据", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { inset: 0; ")),
    ("R14-简写all", "all:initial 重置整份契约", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { all: initial; ")),
    ("R15-属性名大写", "POSITION:static（CSS 属性名大小写不敏感）", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .emblem { POSITION: static; ")),
    ("R13-特异性覆盖", ".paper .emblem 以更高特异性推翻契约", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .paper .emblem { position: static; ")),

    # ── 尺寸与偏移（对照规则 §1.4 登记值）───────────────────────────
    ("R8-桌面尺寸", "桌面尺寸与规则表不符", DAILY,
     lambda t: t.replace("width: 92px; height: 92px;", "width: 120px; height: 92px;", 1)),
    ("R8-窄屏尺寸", "窄屏尺寸与规则表不符", DAILY,
     lambda t: t.replace("width: 70px; height: 70px", "width: 71px; height: 70px", 1)),
    ("R8-窄屏偏移", "窄屏偏移把刊徽推出屏幕", ARCHIVE,
     lambda t: t.replace("top:-8px;right:-2px", "top:-8px;right:-200px", 1)),

    # ── 依赖的上下文：定位祖先 / 前景层级 / 结构性选择器 ───────────
    ("R9-祖先定位", "报头不再是已定位祖先", DAILY,
     lambda t: t.replace("border-bottom: 2.5px solid var(--ink); position: relative;",
                         "border-bottom: 2.5px solid var(--ink);", 1)),
    ("R13-祖先特异性", "header.masthead 以更高特异性改回 static", DAILY,
     lambda t: t.replace("  .masthead {", "  header.masthead { position: static; }\n  .masthead {", 1)),
    ("R10-前景层级", "报头前景层级降到与刊徽同层", DAILY,
     lambda t: t.replace(".masthead .t, .masthead .r, .masthead .stamp { position: relative; z-index: 1; }",
                         ".masthead .t, .masthead .r, .masthead .stamp { position: relative; z-index: 0; }", 1)),
    ("R10-前景未定位", "报头前景未定位导致 z-index 失效", DAILY,
     lambda t: t.replace(".masthead .t, .masthead .r, .masthead .stamp { position: relative; z-index: 1; }",
                         ".masthead .t, .masthead .r, .masthead .stamp { position: static; z-index: 1; }", 1)),
    ("R17-结构性选择器", "不点名类的结构性选择器命中刊徽", DAILY,
     lambda t: sub_after(t, ".emblem svg {", "} .masthead > div:first-child { opacity: 1; ")),

    # ── 行内 style（优先级最高的一档）───────────────────────────────
    ("R16-行内position", "行内 style 让刊徽回到文档流", DAILY,
     lambda t: emblem_open_tag(t, '<div class="emblem" style="position:static">')),
    ("R18-行内opacity", "行内 style 让刊徽完全不透明", DAILY,
     lambda t: emblem_open_tag(t, '<div class="emblem" style="opacity:1">')),
    ("R18-行内display", "行内 style 隐藏刊徽", DAILY,
     lambda t: emblem_open_tag(t, '<div class="emblem" style="display:none">')),
    ("R18-行内尺寸", "行内写死尺寸必然打破某一档", DAILY,
     lambda t: emblem_open_tag(t, '<div class="emblem" style="width:120px">')),

    # ── 冒充与注释（判据边界）───────────────────────────────────────
    ("R19-data-class冒充", "data-class 冒充 class 属性", DAILY,
     lambda t: t.replace('<header class="masthead">', '<header data-class="masthead">', 1)),
    ("R19-CSS注释", "基础 .emblem 规则被 /* */ 注释掉", DAILY,
     lambda t: re.sub(r"(  \.emblem \{ position: absolute;.*?pointer-events: none; \})",
                      r"/* \1 */", t, count=1, flags=re.S)),

    # ── 规则表本身 ─────────────────────────────────────────────────
    ("R8-规则表列缺失", "规则 §1.4 删掉窄屏偏移列", RULE,
     lambda t: t.replace("| 92px | 70px | `top:-14px; right:-8px` | `top:-8px; right:-4px` |",
                         "| 92px | 70px | `top:-14px; right:-8px` |", 1)),

    # ── 守卫自己的 CI 接线 ─────────────────────────────────────────
    ("R6-CI未接线", "被测文件从 CI path filter 摘掉", CI,
     lambda t: t.replace("              - '.claude/rules/report-design-system.md'\n", "", 1)),
]


def build_tree(tmp):
    """把守卫运行所需的文件按原相对路径复制到临时树。"""
    for rel in NEEDED:
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)


def run_guard(tmp):
    """在临时树里跑守卫，返回 (退出码, 输出)。"""
    # **继承当前环境**再加一个变量，不要自己拼一份最小 env：
    # 解释器可能依赖 PYTHONHOME / LD_LIBRARY_PATH / VIRTUAL_ENV 等，
    # 拼一份「我以为够用」的 env 在本机能跑、换个 CI 镜像就起不来——
    # 而那时它会表现成「自测挂了」，排查方向完全错。
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    proc = subprocess.run(
        [sys.executable, str(tmp / GUARD)],
        capture_output=True, text=True, env=env,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main():
    print("刊徽守卫自测：每一种已知退化都必须被判红")
    print("-" * 62)
    failures = []

    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        build_tree(tmp)

        code, out = run_guard(tmp)
        if code != 0:
            print("  [FAIL] 基线未通过——先修守卫或产物，自测无法进行")
            print("\n".join("         " + l for l in out.splitlines()[-8:]))
            return 1
        print(f"  基线通过（{len(CASES)} 条退化用例待验）")

        for cid, desc, rel, mutate in CASES:
            src = tmp / rel
            original = src.read_text(encoding="utf-8")
            try:
                mutated = mutate(original)
            except Exception as e:                  # 变换本身写错了要显式暴露
                failures.append(f"{cid} {desc}：变换执行失败 {type(e).__name__}: {e}")
                print(f"  [FAIL] {cid:22} 变换执行失败：{type(e).__name__}: {e}")
                continue
            if mutated == original:
                # 锚点没命中 = 这条用例其实什么都没改，会假装通过（形状 4b：静默空跑）
                failures.append(f"{cid} {desc}：变换没有改动文件（锚点已失效？）")
                print(f"  [FAIL] {cid:22} 变换没有改动文件——锚点失效，用例是空跑的")
                continue
            src.write_text(mutated, encoding="utf-8")
            try:
                code, _ = run_guard(tmp)
                if code == 0:
                    failures.append(f"{cid} {desc}：守卫判绿（应判红）")
                    print(f"  [FAIL] {cid:22} {desc} —— 守卫判绿，该退化不再被发现")
                else:
                    print(f"  [ ok ] {cid:22} {desc}")
            finally:
                src.write_text(original, encoding="utf-8")

    print("-" * 62)
    if failures:
        print(f"自测未通过：{len(failures)} 条退化守卫抓不到")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"自测通过（{len(CASES)} 种退化全部被守卫判红）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
