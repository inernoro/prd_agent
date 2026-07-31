#!/usr/bin/env python3
"""doc/ 说人话导读校验 + 棘轮。

判据 SSOT：doc/rule.doc.readability.md
每篇 doc/*.md 的第一屏必须有「导读三行」：

    **一句话**：……
    **谁该读**：……
    **读完能做什么**：……

同时校验「引用可点击」：正文里提到另一篇 doc 文档时必须写成相对路径链接，
不能写成一段不能点的行内代码；相对链接的目标必须真实存在（死链零容忍）。

本脚本只做机械判定（有没有、是不是人话形状），不判断内容好坏。
存量欠账走棘轮：`scripts/fixtures/doc-readability-baseline.json` 记录当前欠账数，
只许下降不许上升 —— 新文档必须合规，存量走到哪修到哪。

用法：
    python3 scripts/doc-readability-check.py                # 人读报告
    python3 scripts/doc-readability-check.py --list-missing # 只列欠账文件
    python3 scripts/doc-readability-check.py --ratchet      # CI 闸门
    python3 scripts/doc-readability-check.py --fix-links    # 把裸引用改写成可点链接
    python3 scripts/doc-readability-check.py --update-baseline
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC_DIR = os.path.join(REPO_ROOT, "doc")
BASELINE_PATH = os.path.join(REPO_ROOT, "scripts", "fixtures", "doc-readability-baseline.json")

# 导读三行必须出现在文件开头这么多行内（第一屏）
HEAD_LINES = 25

TYPES = ["spec", "design", "plan", "rule", "guide", "report", "debt"]

FIELDS = ("一句话", "谁该读", "读完能做什么")
# 周报是定期刊物，读者固定（老板 / 产品经理，在周报技能里已声明），
# 因此只要求一句话，且沿用它既有的「本周一句话」写法，不强加另外两行样板。
ONE_LINER_ALIASES = {"一句话", "本周一句话"}
# 豁免只给定期周报 report.YYYY-WNN（读者固定、且是已冻结的历史记录），
# 不给 report. 前缀下所有文件 —— 那批 CDS 审计/验收报告仍要三行。
WEEKLY_REPORT = re.compile(r"^report\.\d{4}-W\d{2}$")   # 尾锚不能省：report.2026-W10-retro 不是周报


def required_fields(name: str) -> tuple[str, ...]:
    if WEEKLY_REPORT.match(name):
        return ("一句话",)
    return FIELDS

# 一句话里出现这些形状就不算人话：代码引用、文件路径
CODE_SPAN = re.compile(r"`[^`]+`")
FILE_PATH = re.compile(r"[\w./-]+\.(?:cs|ts|tsx|js|mjs|py|sh|json|yml|yaml|md|css|rs)\b")
# 驼峰 / 蛇形标识符不禁止 —— 术语是信息密度的延伸。但首次出现必须就地解释，
# 即紧跟一个中文括号把它翻译成人话：`ModelResolver（决定这次调用走哪个模型的那一步）`。
IDENTIFIER = re.compile(r"\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+_[a-z_]+\b")
GLOSS_AFTER = re.compile(r"^\s*[（(]")
# 业界通用专有名词，读者不需要解释；只有内部黑话才要就地翻译
WELL_KNOWN = {"GitHub", "GitLab", "JavaScript", "TypeScript", "PostgreSQL", "MongoDB",
              "MySQL", "JetBrains", "OpenAI", "WebSocket", "DevOps", "PowerShell",
              "OAuth", "GraphQL", "JetPack", "iPhone", "macOS", "iOS"}

# 空话套话：写了等于没写，占着一句话的位置却不给任何信息
VACUOUS = ("相关内容", "有关内容", "进行说明", "做了介绍", "本文介绍了", "进行了阐述",
           "相关规范", "等等", "若干", "诸多")

# 一句话的长度区间（按字符数，中文一字算一个）。
# 上限：超了就不是一句话，是一段话。下限：太短基本等于没说，密度不够。
ONE_LINER_MAX = 100
ONE_LINER_MIN = 20
# 周报的「本周一句话」要向老板交代业务进展 + 关键数字，放宽到 140 字。
ONE_LINER_MAX_BY_TYPE = {"report": 140}
# 谁该读的长度下限：低于此长度基本等于没写（如「所有人」）
AUDIENCE_MIN = 8

# 行内代码里出现的 .md 文件名。只有当它指向 doc/ 下真实存在的文档时才算「本该可点的裸引用」——
# 命名规则里那些「错误示范」文件名并不存在，不会被误伤。
BARE_REF = re.compile(r"`([^`\n]*?([\w][\w.-]*\.md))`")
# 行内链接：目标后面可以跟一个 "标题"（单双引号或圆括号三种写法都合法）。
# 只认最朴素那一种，等于给「带标题的死链」开了一道后门。
MD_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\"|\s+'[^']*'|\s+\([^)]*\))?\s*\)")
# 引用式链接的目标写在定义行上（[ref]: ./x.md），用法处 [文字][ref] 不带路径，
# 所以校验定义行就等于校验了这一类链接。
MD_REF_DEF = re.compile(r"^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?", re.M)
# 形如 wikilink:xxx / prd-nav:4.2 / https:// 的不是文件路径，不做存在性校验
NON_FILE_TARGET = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


FENCE_OPEN = re.compile(r"^(`{3,}|~{3,})\s*(.*)$")


def fence_delim(line: str) -> tuple[str, int] | None:
    """返回这行围栏的 (定界符字符, 长度)，不是围栏则 None。

    两件事都不能省：Markdown 两种围栏都合法（只认反引号的话，`~~~ts` 里的
    实现代码在判据眼里压根不存在）；长度也必须留着 —— 四个反引号包着的
    示例里往往还有三个反引号的内层围栏，按三个就闭合会把外层提前关掉。
    """
    m = FENCE_OPEN.match(line.strip())
    return (m.group(1)[0], len(m.group(1))) if m else None


def fence_closes(opener: tuple[str, int], candidate: tuple[str, int], info: str = "") -> bool:
    """同种定界符、不短于开启行、且不带信息串，才算闭合（CommonMark 规则）。

    ```not-a-close 这种带后缀的行在 Markdown 里仍在块内，判据若把它当闭合，
    后面的实现代码就漏出块外不再计数、链接扫描也会伸进示例里。
    """
    return candidate[0] == opener[0] and candidate[1] >= opener[1] and not info.strip()


def fence_lang(line: str) -> str:
    """取围栏的语言标记：只认第一个词，后面的 title="x" / {linenos} 之类属性丢掉。"""
    m = FENCE_OPEN.match(line.strip())
    info = (m.group(2) if m else "").strip()
    token = re.split(r"[\s,{]", info, 1)[0]
    return token.strip("\"'`{}").lower()


def doc_type(name: str) -> str:
    return name.split(".", 1)[0]


# 标题与导读之间允许的「元信息」：版本行、appKey、关联实现、表格、分隔线、注释、徽章。
# 除此之外的任何一行正文（散文、列表）都意味着导读迟到了。
HEADER_META = re.compile(r"^(\*\*[^*]+\*\*\s*[：:]|\||[-*_]{3,}|!\[|<!--|<img)")


def parse_header(text: str) -> dict[str, str]:
    """从第一屏抓导读三行：H1 之后、第一个小节标题之前。允许行首有 '> ' 引用符。"""
    found: dict[str, str] = {}
    labels = list(ONE_LINER_ALIASES) + [f for f in FIELDS if f != "一句话"]
    in_fence = False
    fence_kind: tuple[str, int] | None = None
    seen_h1 = False
    for raw in text.splitlines()[:HEAD_LINES]:
        line = raw.strip()
        # 代码块里的示例不算数 —— 否则「展示导读格式的模板文档」会自己骗过闸门
        delim = fence_delim(line)
        if delim and (not in_fence or fence_closes(fence_kind, delim, fence_lang(line))):
            in_fence = not in_fence
            fence_kind = delim if in_fence else None
            continue
        if in_fence:
            continue
        if line.startswith("# "):
            seen_h1 = True
            continue
        # 正文一开张，导读就迟到了 —— 埋在某个小节里、或排在整段散文后面的三行，
        # 读者翻到时早已不需要它。标题与导读之间只允许版本行那类元信息。
        if seen_h1 and line:
            core = line.lstrip(">").strip() if line.startswith(">") else line
            is_field = any(re.match(rf"\*\*{lb}\*\*\s*[：:]", core) for lb in labels)
            if not is_field and (re.match(r"^#{2,6} ", line) or not HEADER_META.match(core)):
                break
        # 导读要写在标题下面读者才看得见；写在 H1 之前、或整篇没有 H1，都不算数
        if not seen_h1:
            continue
        if line.startswith(">"):
            line = line.lstrip(">").strip()
        for label in labels:
            m = re.match(rf"\*\*{label}\*\*\s*[：:]\s*(.+)$", line)
            if m:
                key = "一句话" if label in ONE_LINER_ALIASES else label
                found.setdefault(key, m.group(1).strip())
    return found


def check_file(path: str) -> list[str]:
    """返回该文件的问题列表；空列表 = 合规。"""
    name = os.path.basename(path)[: -len(".md")]
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    header = parse_header(text)
    problems: list[str] = []

    for field in required_fields(name):
        if field not in header:
            problems.append(f"缺「{field}」")

    one_liner = header.get("一句话", "")
    if one_liner:
        limit = ONE_LINER_MAX_BY_TYPE.get(doc_type(name), ONE_LINER_MAX)
        if len(one_liner) > limit:
            problems.append(f"「一句话」{len(one_liner)} 字，超过 {limit} 字上限")
        elif len(one_liner) < ONE_LINER_MIN:
            problems.append(f"「一句话」只有 {len(one_liner)} 字，密度不够，说不出内核")
        if CODE_SPAN.search(one_liner):
            problems.append("「一句话」里有代码引用（反引号）")
        elif FILE_PATH.search(one_liner):
            problems.append("「一句话」里有文件路径")
        else:
            for m in IDENTIFIER.finditer(one_liner):
                if m.group(0) in WELL_KNOWN:
                    continue
                if not GLOSS_AFTER.match(one_liner[m.end():]):
                    problems.append(f"术语「{m.group(0)}」未就地解释，后面要紧跟一个中文括号说人话")
                    break
        hit = next((w for w in VACUOUS if w in one_liner), None)
        if hit:
            problems.append(f"「一句话」里有空话「{hit}」，换成这篇独有的信息")

    audience = header.get("谁该读", "")
    if audience and len(audience) < AUDIENCE_MIN:
        problems.append(f"「谁该读」只有 {len(audience)} 字，等于没写")

    if doc_type(name) not in TYPES:
        problems.append(f"前缀 {doc_type(name)} 不在七类里")

    return problems


# 实现语言的代码块：人类不需要在文档里读它，AI 直接读源码更准。
# 允许的代码块语言：契约样例（json/yaml/http）、图（mermaid）、示意（text/无标注）、
# 单条命令（bash/sh）、模板（markdown）。
IMPL_LANGS = {"cs", "csharp", "c#", "ts", "tsx", "typescript", "js", "jsx", "javascript",
              "rust", "rs", "python", "py", "java", "go", "vue", "css", "scss", "sql"}

# 正文里散落的源码路径 / 行号引用。集中列在「实现来源」类小节里是允许的。
# 源码面不止六个产品目录：脚本、技能、规则、工作流同样是实现，散落在散文里
# 一样让读者去读实现。只认产品目录 = 判据比它该管的范围窄。
SOURCE_PATH = re.compile(
    r"(?:\b|(?<=[（(\s]))(?:prd-api|prd-admin|prd-desktop|prd-video|cds|llmgw"
    r"|scripts|\.claude/skills|\.claude/rules|\.Codex/rules|\.github/workflows)/[\w./-]+"
    r"\.(?:cs|csproj|ts|tsx|js|jsx|mjs|py|rs|css|scss|less|sh|yml|yaml|json|html|vue|sql|razor|cshtml)\b")
SOURCE_LINEREF = re.compile(r"\.(?:cs|ts|tsx|js|py|rs):\d+")
# 这些小节就是专门用来指路的，里面列路径不算欠账
SOURCE_SECTION = re.compile(
    r"实现来源|关联实现|关联文件|相关文件|关联代码|事实源|事实入口|代码位置|相关实现|文件索引|实现索引|源码索引")
# 表头写明「这一列是指路的」，整列算成块（读者可整列跳过），不算散落。
# 判据：表头短（≤10 字）且点名了指路含义；「说明」「问题」「做法要点」这类叙述表头不在其中。
POINTER_TOKEN = re.compile(r"文件|实现|代码|位置|路径|来源|守卫|模块|证据|砖块|参照|单测|测试|SSOT|事实源|事实入口")
TABLE_SEP = re.compile(r"^\|[\s\-:|]+\|$")
# 「| 关联 | 一串文件 |」这种元信息行：首列就是指路标签，整行同样算成块。
POINTER_ROW_LABEL = re.compile(
    r"^(?:关联|关联文件|关联改动|关联代码|实现|实现文件|相关文件|文件|代码|代码位置|位置|路径|来源|守卫|守卫测试|模块|模块范围|证据|落地组件|单测|测试)$")


def _is_pointer_name(name: str) -> bool:
    name = name.strip().strip("*` ")
    return len(name) <= 10 and bool(POINTER_TOKEN.search(name))


def _pointer_columns(header: str) -> set[int]:
    return {i for i, c in enumerate(header.strip().strip("|").split("|"))
            if _is_pointer_name(c)}


def scan_body(text: str) -> tuple[int, int]:
    """返回 (实现语言代码行数, 正文里散落的源码路径引用数)。"""
    impl_lines = 0
    src_refs = 0
    in_fence = False
    fence_kind: tuple[str, int] | None = None
    lang = ""
    in_source_section = False
    lines = text.splitlines()
    pointer_cols: set[int] = set()
    for idx, raw in enumerate(lines):
        st = raw.strip()
        delim = fence_delim(st)
        if delim and (not in_fence or fence_closes(fence_kind, delim, fence_lang(st))):
            if not in_fence:
                fence_kind = delim
                in_fence, lang = True, fence_lang(st)
            else:
                in_fence, lang = False, ""
            continue
        if in_fence:
            if lang in IMPL_LANGS:
                impl_lines += 1
            continue
        if st.startswith("#"):
            in_source_section = bool(SOURCE_SECTION.search(st))
            pointer_cols = set()
            continue
        if in_source_section:
            continue
        if st.startswith("|"):
            # 表头行：记下哪些列是指路列；分隔行跳过
            if idx + 1 < len(lines) and TABLE_SEP.match(lines[idx + 1].strip()):
                pointer_cols = _pointer_columns(st)
                continue
            if TABLE_SEP.match(st):
                continue
            cells = st.strip("|").split("|")
            if cells and POINTER_ROW_LABEL.match(cells[0].strip().strip("*` ")):
                continue
            for i, cell in enumerate(cells):
                if i in pointer_cols:
                    continue
                src_refs += len(SOURCE_PATH.findall(cell)) + len(SOURCE_LINEREF.findall(cell))
            continue
        pointer_cols = set()
        src_refs += len(SOURCE_PATH.findall(raw)) + len(SOURCE_LINEREF.findall(raw))
    return impl_lines, src_refs


def per_file_debt() -> dict[str, dict[str, int]]:
    """按文件记欠账：{文件名: {missing/bare/impl/src: 数值}}。

    棘轮只比总数是拦不住「拆东墙补西墙」的：修好一篇旧的、同时新增一篇不合规的，
    总数没变、CI 照样绿。所以基线必须记到文件级——**新出现的欠账文件一律判红**，
    存量文件也只许比基线少。
    """
    known = doc_filenames()
    out: dict[str, dict[str, int]] = {}
    for name in sorted(os.listdir(DOC_DIR)):
        if not name.endswith(".md") or doc_type(name) not in TYPES:
            continue
        path = os.path.join(DOC_DIR, name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        impl, src = scan_body(text)
        entry = {
            "missing": 1 if check_file(path) else 0,
            "bare": len(find_bare_refs(text, known)),
            "impl": impl,
            "src": src,
        }
        if any(entry.values()):
            out[name] = entry
    return out


def scan_bodies() -> tuple[dict[str, int], dict[str, int], list[str]]:
    """按类型统计正文里的实现细节欠账。"""
    impl = {t: 0 for t in TYPES}
    srcs = {t: 0 for t in TYPES}
    detail: list[str] = []
    for name in sorted(os.listdir(DOC_DIR)):
        if not name.endswith(".md"):
            continue
        t = doc_type(name)
        if t not in TYPES:
            continue
        with open(os.path.join(DOC_DIR, name), encoding="utf-8") as fh:
            text = fh.read()
        i, s = scan_body(text)
        impl[t] += i
        srcs[t] += s
        if i or s:
            bits = []
            if i:
                bits.append(f"实现代码 {i} 行")
            if s:
                bits.append(f"散落源码路径 {s} 处")
            detail.append(f"doc/{name} — {'，'.join(bits)}")
    return impl, srcs, detail


def doc_filenames() -> set[str]:
    return {n for n in os.listdir(DOC_DIR) if n.endswith(".md")}


def body_lines(text: str):
    """逐行产出正文（跳过围栏代码块）——代码块里的路径是示例，不该变成链接。"""
    in_fence = False
    fence_kind: tuple[str, int] | None = None
    for idx, raw in enumerate(text.splitlines()):
        delim = fence_delim(raw)
        if delim and (not in_fence or fence_closes(fence_kind, delim, fence_lang(raw))):
            in_fence = not in_fence
            fence_kind = delim if in_fence else None
            continue
        if not in_fence:
            yield idx + 1, raw


def link_spans(line: str) -> list[tuple[int, int]]:
    """已经是 markdown 链接的区间。链接文字里的行内代码已经可点，不算裸引用，
    也绝不能再包一层——那会生成 [[x](./x)](./x) 这种嵌套坏链。"""
    return [m.span() for m in MD_LINK.finditer(line)]


def _inside(span: tuple[int, int], spans: list[tuple[int, int]]) -> bool:
    return any(s <= span[0] and span[1] <= e for s, e in spans)


def find_bare_refs(text: str, known: set[str]) -> list[tuple[int, str]]:
    """行内代码写的 doc 引用（目标真实存在 = 本该是可点链接）。"""
    hits: list[tuple[int, str]] = []
    for lineno, line in body_lines(text):
        spans = link_spans(line)
        for m in BARE_REF.finditer(line):
            if m.group(2) in known and not _inside(m.span(), spans):
                hits.append((lineno, m.group(1)))
    return hits


def find_dead_links(path: str, text: str) -> list[tuple[int, str]]:
    """相对路径 markdown 链接指向不存在的文件 = 死链，零容忍。"""
    dead: list[tuple[int, str]] = []
    base = os.path.dirname(path)
    for lineno, line in body_lines(text):
        targets = [m.group(1) for m in MD_LINK.finditer(line)]
        # 引用式链接的定义行（[ref]: ./x.md）也得验：用法处不带路径，漏了它
        # 这一类死链永远没人发现
        targets += [m.group(1) for m in MD_REF_DEF.finditer(line)]
        for raw_target in targets:
            target = raw_target.split("#")[0]
            if not target or NON_FILE_TARGET.match(target):
                continue
            if not os.path.exists(os.path.normpath(os.path.join(base, target))):
                dead.append((lineno, raw_target))
    return dead


def fix_links(text: str, known: set[str]) -> tuple[str, int]:
    """把 `xxx.md` 形式的裸引用改写成 [xxx.md](./xxx.md)，只动正文、只动真实存在的目标。"""
    out: list[str] = []
    changed = 0
    in_fence = False
    fence_kind: tuple[str, int] | None = None
    for raw in text.splitlines(keepends=True):
        delim = fence_delim(raw)
        if delim and (not in_fence or fence_closes(fence_kind, delim, fence_lang(raw))):
            in_fence = not in_fence
            fence_kind = delim if in_fence else None
            out.append(raw)
            continue
        if in_fence:
            out.append(raw)
            continue

        spans = link_spans(raw)

        def repl(m: re.Match[str]) -> str:
            nonlocal changed
            if m.group(2) not in known or _inside(m.span(), spans):
                return m.group(0)
            changed += 1
            return f"[{m.group(1)}](./{m.group(2)})"

        out.append(BARE_REF.sub(repl, raw))
    return "".join(out), changed


def scan_links() -> tuple[dict[str, int], list[str], list[str]]:
    """返回 (每类裸引用数, 裸引用明细, 死链明细)。"""
    known = doc_filenames()
    per_type = {t: 0 for t in TYPES}
    bare_detail: list[str] = []
    dead_detail: list[str] = []
    for name in sorted(known):
        t = doc_type(name)
        if t not in TYPES:
            continue
        path = os.path.join(DOC_DIR, name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for lineno, ref in find_bare_refs(text, known):
            per_type[t] += 1
            bare_detail.append(f"doc/{name}:{lineno} — 裸引用 `{ref}`，应写成可点链接")
        for lineno, target in find_dead_links(path, text):
            dead_detail.append(f"doc/{name}:{lineno} — 死链 {target}")
    return per_type, bare_detail, dead_detail


# 规则不止一处：Claude 读 .claude/rules，Codex 读 .Codex/rules。少扫一处，
# 那一处就能绕开导读要求（形状 1：判据比它该管的范围窄）。
RULE_DIRS = [os.path.join(".claude", "rules"), os.path.join(".Codex", "rules")]
RULES_DIR = os.path.join(REPO_ROOT, ".claude", "rules")
# 技能根同样不止一处：Claude 读 .claude/skills，Codex 读 .agents/skills
# （skill-install-contract 规定安装时所有存在的宿主目录都要装一份）。
SKILL_DIRS = [os.path.join(".claude", "skills"), os.path.join(".agents", "skills")]
SKILLS_DIR = os.path.join(REPO_ROOT, ".claude", "skills")

# 规则文档的导读只要两行：这条规则要求什么、什么改动会撞上它。
# 规则的主要读者是按 glob 自动加载它的 AI，人是次要读者，所以比 doc/ 少一行、不强求「读完能做什么」。
RULE_FIELDS = ("一句话", "什么时候撞上")
RULE_ONE_LINER_MIN = 20
RULE_WHEN_MIN = 6


def check_rule(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        return check_rule_text(fh.read())


def check_rule_text(text: str) -> list[str]:
    """规则文档的轻量导读校验：H1 之后必须有一句话 + 什么时候撞上。

    和 doc/ 的 parse_header 同口径：代码块里的示例不算数（否则「展示规则导读格式的
    模板」会自己骗过闸门），H1 之前的也不算数（导读要在标题下面，读者才看得见）。
    """
    found: dict[str, str] = {}
    in_fence = False
    fence_kind: tuple[str, int] | None = None
    seen_h1 = False
    for raw in text.splitlines()[:HEAD_LINES]:
        line = raw.strip()
        delim = fence_delim(line)
        if delim and (not in_fence or fence_closes(fence_kind, delim, fence_lang(line))):
            in_fence = not in_fence
            fence_kind = delim if in_fence else None
            continue
        if in_fence:
            continue
        if line.startswith("# "):
            seen_h1 = True
            continue
        # 与 doc/ 同一口径：正文一开张导读就迟到了，埋在小节里的两行不算数
        if seen_h1 and re.match(r"^#{2,6} ", line):
            break
        if not seen_h1:
            continue
        for label in RULE_FIELDS:
            m = re.match(rf"\*\*{label}\*\*\s*[：:]\s*(.+)$", line)
            if m:
                found.setdefault(label, m.group(1).strip())
    problems = [f"缺「{f}」" for f in RULE_FIELDS if f not in found]
    one = found.get("一句话", "")
    if one and len(one) < RULE_ONE_LINER_MIN:
        problems.append(f"「一句话」只有 {len(one)} 字，说不出这条规则要求什么")
    if one and CODE_SPAN.search(one) and FILE_PATH.search(one):
        problems.append("「一句话」被文件路径占满，先说人话再说路径")
    when = found.get("什么时候撞上", "")
    if when and len(when) < RULE_WHEN_MIN:
        problems.append(f"「什么时候撞上」只有 {len(when)} 字，等于没写")
    return problems


def yaml_scalar(raw: str) -> str:
    """取 YAML 未加引号标量的真实值：剥掉行内注释与引号。

    `description: # TODO 回头再写` 在 YAML 里值是 null，不是那句 TODO —— 判据
    要是把注释当值，占位符就能冒充一句合格的描述。
    """
    value = raw.strip()
    if value.startswith("#"):
        return ""
    if value[:1] in ("\"", "'"):   # 注意空串 in 任何字符串恒为真，必须比元组
        quote = value[0]
        end = value.find(quote, 1)
        return value[1:end] if end > 0 else value[1:]
    value = re.split(r"\s+#", value, 1)[0]
    return value.strip()

# description 必须回答「什么时候轮到这个技能」：触发词、使用场景从句、或斜杠命令。
# 只讲能力不讲时机的描述，调度器无从判断该不该选它（doc/rule.skill.header.md）。
TRIGGER_CUE = re.compile(
    r"触发词|触发|使用时机|时使用|时触发|当用户|什么时候|适用于|用于|"
    r"[Tt]rigger|[Uu]se (this|when|it when)|[Aa]ctivates|[Ww]hen the user|[Ww]hen you|"
    r"[Ii]nvoke|Actions?:|/[a-z][a-z0-9-]{3,}")


def check_skill(path: str) -> list[str]:
    """技能文档：frontmatter 必须有 name 与 description，且 description 要说清什么时候用它。"""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if not text.startswith("---"):
        return ["缺 frontmatter（技能靠它被发现和触发）"]
    end = text.find("\n---", 3)
    fm = text[3:end] if end != -1 else ""
    problems = []
    # 同一个键写两遍时，判据看第一处、YAML 消费方通常取最后一处 —— 两边看的
    # 不是同一个值，判据就等于没判。重复键一律判红，不去猜哪一处才算数。
    for key in ("name", "description"):
        if len(re.findall(rf"^{key}\s*:", fm, re.M)) > 1:
            problems.append(f"frontmatter 里 {key} 写了多遍（判据看第一处、YAML 取最后一处，必须去重）")
    name_match = re.search(r"^name\s*:(.*)$", fm, re.M)
    if not name_match:
        problems.append("frontmatter 缺 name")
    else:
        skill_name = yaml_scalar(name_match.group(1))
        skill_dir = os.path.basename(os.path.dirname(path))
        if not skill_name:
            # 有键无值等于没有 —— 技能靠 name 被找到，空值找不到任何东西
            problems.append("frontmatter 的 name 是空值")
        elif not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", skill_name):
            problems.append(f"frontmatter 的 name「{skill_name}」不是 kebab-case")
        elif skill_name != skill_dir:
            # name 就是技能的身份，对不上目录时调用方按目录名找不到它
            problems.append(f"frontmatter 的 name「{skill_name}」与目录名「{skill_dir}」不一致")
    desc = _frontmatter_description(fm)
    if desc is None:
        problems.append("frontmatter 缺 description")
    elif len(desc) < 30:
        problems.append("description 太短，说不清这个技能什么时候该被触发")
    elif not TRIGGER_CUE.search(desc):
        # 长度够但只讲「我能干什么」，没讲「什么时候轮到我」——调度器据此选不中它
        problems.append("description 只讲了能力，没讲触发时机（触发词 / 什么场景下用 / 斜杠命令）")
    return problems


def _frontmatter_description(fm: str) -> str | None:
    """取 description 的完整值，支持 YAML 折叠块（`|` / `>`）——它们的正文在后续缩进行里。"""
    lines = fm.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^description\s*:\s*(.*)$", line)
        if not m:
            continue
        head = m.group(1).strip()
        if head and head[0] not in "|>":
            # 纯注释的 head 在 YAML 里就是 null，返回 None 让上面判「缺 description」
            return yaml_scalar(head) or None
        body = []
        for nxt in lines[i + 1:]:
            if nxt.strip() and not nxt.startswith((" ", "\t")):
                break
            body.append(nxt.strip())
        return " ".join(x for x in body if x)
    return None


def scan_rules() -> tuple[int, int, list[str]]:
    total = missing = 0
    detail: list[str] = []
    for rel_dir in RULE_DIRS:
        abs_dir = os.path.join(REPO_ROOT, rel_dir)
        if not os.path.isdir(abs_dir):
            continue
        for name in sorted(os.listdir(abs_dir)):
            if not name.endswith(".md"):
                continue
            total += 1
            problems = check_rule(os.path.join(abs_dir, name))
            if problems:
                missing += 1
                detail.append(f"{rel_dir.replace(os.sep, '/')}/{name} — {'；'.join(problems)}")
    return total, missing, detail


def scan_skills() -> tuple[int, int, list[str]]:
    total = missing = 0
    detail: list[str] = []
    for rel_dir in SKILL_DIRS:
        abs_dir = os.path.join(REPO_ROOT, rel_dir)
        if not os.path.isdir(abs_dir):
            continue
        for name in sorted(os.listdir(abs_dir)):
            path = os.path.join(abs_dir, name, "SKILL.md")
            if not os.path.isfile(path):
                continue
            total += 1
            problems = check_skill(path)
            if problems:
                missing += 1
                detail.append(f"{rel_dir.replace(os.sep, '/')}/{name}/SKILL.md — {'；'.join(problems)}")
    return total, missing, detail



def scan() -> tuple[dict[str, dict[str, int]], dict[str, list[str]]]:
    stats: dict[str, dict[str, int]] = {t: {"total": 0, "missing": 0} for t in TYPES}
    missing: dict[str, list[str]] = {t: [] for t in TYPES}

    for name in sorted(os.listdir(DOC_DIR)):
        if not name.endswith(".md"):
            continue
        t = doc_type(name)
        if t not in TYPES:
            # 前缀非法由 doc-sync / rule.doc.naming 管，这里不重复报
            continue
        stats[t]["total"] += 1
        problems = check_file(os.path.join(DOC_DIR, name))
        if problems:
            stats[t]["missing"] += 1
            missing[t].append(f"doc/{name} — {'；'.join(problems)}")

    return stats, missing


_DEBT_WORDS = {"missing": "缺导读", "bare": "裸引用", "impl": "实现代码", "src": "散落源码路径"}


def _debt_words(entry: dict[str, int]) -> str:
    bits = [f"{_DEBT_WORDS[k]} {v}" for k, v in entry.items() if v]
    return "、".join(bits) if bits else "无"


def _normalize_baseline(data: dict) -> dict:
    return {"missing": data.get("missing", {}), "bare_refs": data.get("bare_refs", {}),
            "impl_code": data.get("impl_code", {}), "source_refs": data.get("source_refs", {}),
            "rules_missing": data.get("rules_missing", 0),
            "skills_missing": data.get("skills_missing", 0),
            "files": data.get("files", {})}


def load_baseline() -> dict[str, dict[str, int]]:
    if not os.path.exists(BASELINE_PATH):
        return {}
    with open(BASELINE_PATH, encoding="utf-8") as fh:
        return _normalize_baseline(json.load(fh))


def git_ref_exists(ref: str) -> bool:
    import subprocess
    try:
        out = subprocess.run(["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], cwd=REPO_ROOT,
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0


def load_baseline_at(ref: str) -> dict | None:
    """读某个 git ref 上的基线；取不到返回 None（本地没 fetch 时不阻塞）。"""
    import subprocess
    rel = os.path.relpath(BASELINE_PATH, REPO_ROOT).replace(os.sep, "/")
    try:
        out = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=REPO_ROOT,
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    try:
        return _normalize_baseline(json.loads(out.stdout))
    except json.JSONDecodeError:
        return None


def baseline_regressions(base: dict, submitted: dict) -> list[str]:
    """提交的基线相对目标分支是不是被放宽了。

    棘轮只跟工作树比本分支自己的基线，于是「先制造欠账、再跑 --update-baseline」
    能让 CI 拿放宽后的基线跟自己比，判据形同虚设。所以先比基线本身。
    """
    bad: list[str] = []
    for key in ("missing", "bare_refs", "impl_code", "source_refs"):
        for doc_t, allowed in base.get(key, {}).items():
            now = submitted.get(key, {}).get(doc_t, 0)
            if now > allowed:
                bad.append(f"{key}.{doc_t}: 目标分支 {allowed} → 本分支 {now}")
    for key in ("rules_missing", "skills_missing"):
        if submitted.get(key, 0) > base.get(key, 0):
            bad.append(f"{key}: 目标分支 {base.get(key, 0)} → 本分支 {submitted.get(key, 0)}")
    base_files, now_files = base.get("files", {}), submitted.get("files", {})
    added = [f for f in now_files if f not in base_files]
    if added:
        bad.append(f"新增欠账文件被写进基线：{added[:5]}")
    # 只挡新文件名挡不住「债务在文件之间挪位」：A 篇加一处、B 篇减一处，
    # 总数持平、文件名也没新增，逐篇明细却被放宽了。
    for fname, now_val in now_files.items():
        base_val = base_files.get(fname)
        if base_val is None:
            continue
        if isinstance(now_val, dict) and isinstance(base_val, dict):
            for k, v in now_val.items():
                if v > base_val.get(k, 0):
                    bad.append(f"{fname}.{k}: 目标分支 {base_val.get(k, 0)} → 本分支 {v}")
        elif isinstance(now_val, (int, float)) and isinstance(base_val, (int, float)):
            if now_val > base_val:
                bad.append(f"{fname}: 目标分支 {base_val} → 本分支 {now_val}")
    return bad


def write_baseline(stats: dict[str, dict[str, int]], bare: dict[str, int],
                   impl: dict[str, int], srcs: dict[str, int],
                   rules_missing: int = 0, skills_missing: int = 0,
                   files: dict[str, dict[str, int]] | None = None) -> None:
    payload = {
        "_comment": (
            "doc/ 可读性棘轮基线。判据见 doc/rule.doc.readability.md。"
            "missing = 缺导读三行的篇数；bare_refs = 本该可点却写成行内代码的引用处数；"
            "impl_code = 正文里实现语言代码块的行数；source_refs = 正文里散落的源码路径引用数"
            "（集中列在「实现来源」小节里的不计）；rules_missing = .claude/rules 里缺导读两行的条数；"
            "skills_missing = 技能 frontmatter 缺 name/description 的个数。"
            "files = 逐篇欠账明细（missing/bare/impl/src），用来拦住「修好一篇旧的、同时新增一篇新的」"
            "这种总数不变的偷换：不在这张表里的文件一旦欠账即判红。"
            "数值只许下降：修好存量就跑 --update-baseline "
            "把它压低；上调必须在 PR 里说明原因，否则一律 reject。死链不进棘轮，零容忍。"
        ),
        "missing": {t: stats[t]["missing"] for t in TYPES},
        "bare_refs": {t: bare.get(t, 0) for t in TYPES},
        "impl_code": {t: impl.get(t, 0) for t in TYPES},
        "source_refs": {t: srcs.get(t, 0) for t in TYPES},
        "rules_missing": rules_missing,
        "skills_missing": skills_missing,
        "files": files or {},
    }
    os.makedirs(os.path.dirname(BASELINE_PATH), exist_ok=True)
    with open(BASELINE_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratchet", action="store_true", help="与基线比对，欠账上升即失败（CI 用）")
    ap.add_argument("--update-baseline", action="store_true", help="把当前欠账写回基线")
    ap.add_argument("--list-missing", action="store_true", help="逐条列出欠账文件")
    ap.add_argument("--baseline-ref", default="",
                    help="拿这个 git ref 上的基线当上限，防止本分支自己把基线放宽（CI 传 origin/main）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--fix-links", action="store_true",
                    help="把指向真实文档的裸引用批量改写成可点链接")
    args = ap.parse_args()

    if args.fix_links:
        known = doc_filenames()
        touched = 0
        rewritten = 0
        for name in sorted(known):
            path = os.path.join(DOC_DIR, name)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            new_text, n = fix_links(text, known)
            if n:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(new_text)
                touched += 1
                rewritten += n
        print(f"已把 {rewritten} 处裸引用改写为可点链接，涉及 {touched} 篇")
        return 0

    stats, missing = scan()
    bare_per_type, bare_detail, dead_detail = scan_links()
    impl_per_type, src_per_type, body_detail = scan_bodies()
    rules_total, rules_missing, rules_detail = scan_rules()
    file_debt = per_file_debt()
    skills_total, skills_missing, skills_detail = scan_skills()
    total = sum(s["total"] for s in stats.values())
    total_missing = sum(s["missing"] for s in stats.values())
    total_bare = sum(bare_per_type.values())
    total_impl = sum(impl_per_type.values())
    total_src = sum(src_per_type.values())

    if args.update_baseline:
        write_baseline(stats, bare_per_type, impl_per_type, src_per_type,
                       rules_missing, skills_missing, file_debt)
        print(f"基线已更新：{total_missing} / {total} 篇仍欠导读三行；裸引用 {total_bare} 处；"
              f"实现代码 {total_impl} 行；散落源码路径 {total_src} 处；"
              f"规则欠导读 {rules_missing} 条；技能 frontmatter 欠账 {skills_missing} 个")
        return 0

    if args.json:
        print(json.dumps({"stats": stats, "missing": missing,
                          "bare_refs": bare_per_type, "dead_links": dead_detail,
                          "impl_code": impl_per_type, "source_refs": src_per_type,
                          "rules": {"total": rules_total, "missing": rules_missing,
                                    "detail": rules_detail},
                          "skills": {"total": skills_total, "missing": skills_missing,
                                     "detail": skills_detail}},
                         ensure_ascii=False, indent=2))
        return 0

    print(f"{'类型':<8}{'篇数':>6}{'已达标':>8}{'欠账':>6}{'达标率':>8}")
    for t in TYPES:
        s = stats[t]
        ok = s["total"] - s["missing"]
        rate = f"{ok / s['total'] * 100:.0f}%" if s["total"] else "-"
        print(f"{t:<8}{s['total']:>6}{ok:>8}{s['missing']:>6}{rate:>8}")
    print(f"{'合计':<8}{total:>6}{total - total_missing:>8}{total_missing:>6}"
          f"{(total - total_missing) / total * 100:>7.0f}%")
    print(f"\n引用可点击：裸引用 {total_bare} 处，死链 {len(dead_detail)} 处")
    print(f"正文实现细节：实现语言代码 {total_impl} 行，散落源码路径 {total_src} 处")
    print(f"规则与技能：{rules_total} 条规则欠导读 {rules_missing} 条；"
          f"{skills_total} 个技能 frontmatter 欠账 {skills_missing} 个")

    if args.list_missing:
        print()
        for t in TYPES:
            for line in missing[t]:
                print(line)
        for line in bare_detail:
            print(line)
        for line in body_detail:
            print(line)
        for line in dead_detail:
            print(line)

    if args.ratchet:
        baseline = load_baseline()
        if args.baseline_ref:
            if not git_ref_exists(args.baseline_ref):
                # 静默降级等于把闸门关掉：取不到对照物就该失败，而不是拿本分支
                # 自己放宽后的基线跟自己比
                print(f"\n[FAIL] 取不到用于对照的 {args.baseline_ref} —— 无法确认基线没被放宽。"
                      f"CI 里通常是 base 分支没 fetch 到；本地跑加 --baseline-ref 请先 git fetch",
                      file=sys.stderr)
                return 1
            base_baseline = load_baseline_at(args.baseline_ref)
            if base_baseline is None:
                # ref 在、但那上面还没有基线文件：这是基线首次引入的正常情况
                print(f"[INFO] {args.baseline_ref} 上还没有基线文件（首次引入），跳过放宽检查",
                      file=sys.stderr)
            else:
                relaxed = baseline_regressions(base_baseline, baseline)
                if relaxed:
                    print(f"\n[FAIL] 本分支把基线放宽了 —— 「先制造欠账、再 --update-baseline」"
                          f"不算持平，判据见 doc/rule.doc.readability.md", file=sys.stderr)
                    for line in relaxed:
                        print(f"  {line}", file=sys.stderr)
                    print("  确有正当理由要抬基线时，在 PR 里说明并让人类 reviewer 放行",
                          file=sys.stderr)
                    return 1
        if not baseline:
            print("\n[FAIL] 缺基线文件，先跑 --update-baseline", file=sys.stderr)
            return 1

        if dead_detail:
            print("\n[FAIL] 存在死链 —— 引用的文档不存在，零容忍（不走棘轮）", file=sys.stderr)
            for line in dead_detail[:20]:
                print(f"    {line}", file=sys.stderr)
            return 1

        bare_regressions = [
            (t, baseline["bare_refs"].get(t, 0), bare_per_type[t])
            for t in TYPES if bare_per_type[t] > baseline["bare_refs"].get(t, 0)
        ]
        if bare_regressions:
            print("\n[FAIL] 裸引用增加 —— 引用别的文档要写成可点链接 [xxx.md](./xxx.md)，"
                  "判据见 doc/rule.doc.readability.md", file=sys.stderr)
            for t, allowed, actual in bare_regressions:
                print(f"  {t}: 基线 {allowed} → 当前 {actual}", file=sys.stderr)
            for line in bare_detail[:10]:
                print(f"    {line}", file=sys.stderr)
            if len(bare_detail) > 10:
                print(f"    ……另有 {len(bare_detail) - 10} 处，跑 --list-missing 看全部",
                      file=sys.stderr)
            print("    修法：python3 scripts/doc-readability-check.py --fix-links", file=sys.stderr)
            return 1

        for key, actual_map, label, howto in (
            ("impl_code", impl_per_type, "正文实现代码",
             "实现代码不进文档——删掉，或换成契约表 / 数据流说明；AI 需要细节时直接读源码"),
            ("source_refs", src_per_type, "散落的源码路径引用",
             "把路径集中到文末「实现来源」小节，正文用人话讲清职责与数据流"),
        ):
            over = [(t, baseline[key].get(t, 0), actual_map[t])
                    for t in TYPES if actual_map[t] > baseline[key].get(t, 0)]
            if over:
                print(f"\n[FAIL] {label}增加 —— {howto}，判据见 doc/rule.doc.readability.md",
                      file=sys.stderr)
                for t, allowed, actual in over:
                    print(f"  {t}: 基线 {allowed} → 当前 {actual}", file=sys.stderr)
                for line in body_detail[:10]:
                    print(f"    {line}", file=sys.stderr)
                return 1

        base_files = baseline.get("files", {})
        newly: list[str] = []
        worse: list[str] = []
        for name, cur in sorted(file_debt.items()):
            was = base_files.get(name)
            if was is None:
                newly.append(f"doc/{name} — {_debt_words(cur)}")
                continue
            up = [k for k in ("missing", "bare", "impl", "src") if cur[k] > was.get(k, 0)]
            if up:
                worse.append(f"doc/{name} — {_debt_words({k: cur[k] for k in up})}"
                             f"（基线 {_debt_words({k: was.get(k, 0) for k in up})}）")
        if newly or worse:
            print("\n[FAIL] 有文档新欠账 —— 棘轮记到文件级，"
                  "「修好一篇旧的、同时新增一篇不合规的」不算持平，判据见 doc/rule.doc.readability.md",
                  file=sys.stderr)
            for line in newly[:10]:
                print(f"  新增欠账：{line}", file=sys.stderr)
            for line in worse[:10]:
                print(f"  欠账变多：{line}", file=sys.stderr)
            print("  修好它，或确有正当理由时跑 --update-baseline 并在 PR 里说明", file=sys.stderr)
            return 1

        for label, actual, allowed, detail, hint in (
            ("规则导读", rules_missing, baseline.get("rules_missing", 0), rules_detail,
             ".claude/rules 下每条规则的 H1 之后要有「一句话」+「什么时候撞上」两行"),
            ("技能 frontmatter ", skills_missing, baseline.get("skills_missing", 0), skills_detail,
             "每个 SKILL.md 的 frontmatter 要有 name 与能说清触发时机的 description"),
        ):
            if actual > allowed:
                print(f"\n[FAIL] {label}欠账上升 —— {hint}", file=sys.stderr)
                print(f"  基线 {allowed} → 当前 {actual}", file=sys.stderr)
                for line in detail[:10]:
                    print(f"    {line}", file=sys.stderr)
                return 1

        regressions = []
        for t in TYPES:
            allowed = baseline["missing"].get(t, 0)
            actual = stats[t]["missing"]
            if actual > allowed:
                regressions.append((t, allowed, actual))
        if regressions:
            print("\n[FAIL] 导读欠账上升 —— 新文档必须带导读三行，判据见 doc/rule.doc.readability.md",
                  file=sys.stderr)
            for t, allowed, actual in regressions:
                print(f"  {t}: 基线 {allowed} → 当前 {actual}", file=sys.stderr)
                shown = missing[t][:10]
                for line in shown:
                    print(f"    {line}", file=sys.stderr)
                if len(missing[t]) > len(shown):
                    print(f"    ……另有 {len(missing[t]) - len(shown)} 篇欠账未列出，"
                          f"跑 --list-missing 看全部", file=sys.stderr)
            return 1
        improved = sum(baseline["missing"].get(t, 0) for t in TYPES) - total_missing
        bare_improved = sum(baseline["bare_refs"].get(t, 0) for t in TYPES) - total_bare
        impl_improved = sum(baseline["impl_code"].get(t, 0) for t in TYPES) - total_impl
        src_improved = sum(baseline["source_refs"].get(t, 0) for t in TYPES) - total_src
        gains = improved + bare_improved + impl_improved + src_improved
        if gains > 0:
            print(f"\n[OK] 比基线少 {improved} 篇缺导读、少 {bare_improved} 处裸引用、"
                  f"少 {impl_improved} 行实现代码、少 {src_improved} 处源码路径。"
                  f"修完记得跑 --update-baseline 把基线压低。")
        else:
            print("\n[OK] 六项欠账均未上升，无死链。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
