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
REQUIRED_BY_TYPE = {"report": ("一句话",)}

# 一句话里出现这些形状就不算人话：代码引用、文件路径、驼峰/蛇形标识符
CODE_SPAN = re.compile(r"`[^`]+`")
FILE_PATH = re.compile(r"[\w./-]+\.(?:cs|ts|tsx|js|mjs|py|sh|json|yml|yaml|md|css|rs)\b")
IDENTIFIER = re.compile(r"\b[A-Za-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+_[a-z_]+\b")

# 一句话的长度上限（按字符数，中文一字算一个）。超了就不是一句话，是一段话。
ONE_LINER_MAX = 80
# 周报的「本周一句话」要向老板交代业务进展 + 关键数字，放宽到 140 字。
ONE_LINER_MAX_BY_TYPE = {"report": 140}
# 谁该读的长度下限：低于此长度基本等于没写（如「所有人」）
AUDIENCE_MIN = 8

# 行内代码里出现的 .md 文件名。只有当它指向 doc/ 下真实存在的文档时才算「本该可点的裸引用」——
# 命名规则里那些「错误示范」文件名并不存在，不会被误伤。
BARE_REF = re.compile(r"`([^`\n]*?([\w][\w.-]*\.md))`")
MD_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
# 形如 wikilink:xxx / prd-nav:4.2 / https:// 的不是文件路径，不做存在性校验
NON_FILE_TARGET = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def doc_type(name: str) -> str:
    return name.split(".", 1)[0]


def parse_header(text: str) -> dict[str, str]:
    """从第一屏抓导读三行。允许行首有 '> ' 引用符。"""
    found: dict[str, str] = {}
    labels = list(ONE_LINER_ALIASES) + [f for f in FIELDS if f != "一句话"]
    in_fence = False
    for raw in text.splitlines()[:HEAD_LINES]:
        line = raw.strip()
        # 代码块里的示例不算数 —— 否则「展示导读格式的模板文档」会自己骗过闸门
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
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

    for field in REQUIRED_BY_TYPE.get(doc_type(name), FIELDS):
        if field not in header:
            problems.append(f"缺「{field}」")

    one_liner = header.get("一句话", "")
    if one_liner:
        limit = ONE_LINER_MAX_BY_TYPE.get(doc_type(name), ONE_LINER_MAX)
        if len(one_liner) > limit:
            problems.append(f"「一句话」{len(one_liner)} 字，超过 {limit} 字上限")
        if CODE_SPAN.search(one_liner):
            problems.append("「一句话」里有代码引用（反引号）")
        elif FILE_PATH.search(one_liner):
            problems.append("「一句话」里有文件路径")
        elif IDENTIFIER.search(one_liner):
            problems.append("「一句话」里有驼峰/蛇形标识符")

    audience = header.get("谁该读", "")
    if audience and len(audience) < AUDIENCE_MIN:
        problems.append(f"「谁该读」只有 {len(audience)} 字，等于没写")

    if doc_type(name) not in TYPES:
        problems.append(f"前缀 {doc_type(name)} 不在七类里")

    return problems


def doc_filenames() -> set[str]:
    return {n for n in os.listdir(DOC_DIR) if n.endswith(".md")}


def body_lines(text: str):
    """逐行产出正文（跳过围栏代码块）——代码块里的路径是示例，不该变成链接。"""
    in_fence = False
    for idx, raw in enumerate(text.splitlines()):
        if raw.strip().startswith("```"):
            in_fence = not in_fence
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
        for m in MD_LINK.finditer(line):
            target = m.group(1).split("#")[0]
            if not target or NON_FILE_TARGET.match(target):
                continue
            if not os.path.exists(os.path.normpath(os.path.join(base, target))):
                dead.append((lineno, m.group(1)))
    return dead


def fix_links(text: str, known: set[str]) -> tuple[str, int]:
    """把 `xxx.md` 形式的裸引用改写成 [xxx.md](./xxx.md)，只动正文、只动真实存在的目标。"""
    out: list[str] = []
    changed = 0
    in_fence = False
    for raw in text.splitlines(keepends=True):
        if raw.strip().startswith("```"):
            in_fence = not in_fence
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


def load_baseline() -> dict[str, dict[str, int]]:
    if not os.path.exists(BASELINE_PATH):
        return {}
    with open(BASELINE_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    return {"missing": data.get("missing", {}), "bare_refs": data.get("bare_refs", {})}


def write_baseline(stats: dict[str, dict[str, int]], bare: dict[str, int]) -> None:
    payload = {
        "_comment": (
            "doc/ 可读性棘轮基线。判据见 doc/rule.doc.readability.md。"
            "missing = 缺导读三行的篇数；bare_refs = 本该可点却写成行内代码的引用处数。"
            "两个数值都只许下降：修好存量就跑 --update-baseline 把它压低；"
            "上调必须在 PR 里说明原因，否则一律 reject。死链不进棘轮，零容忍。"
        ),
        "missing": {t: stats[t]["missing"] for t in TYPES},
        "bare_refs": {t: bare.get(t, 0) for t in TYPES},
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
    total = sum(s["total"] for s in stats.values())
    total_missing = sum(s["missing"] for s in stats.values())
    total_bare = sum(bare_per_type.values())

    if args.update_baseline:
        write_baseline(stats, bare_per_type)
        print(f"基线已更新：{total_missing} / {total} 篇仍欠导读三行；裸引用 {total_bare} 处")
        return 0

    if args.json:
        print(json.dumps({"stats": stats, "missing": missing,
                          "bare_refs": bare_per_type, "dead_links": dead_detail},
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

    if args.list_missing:
        print()
        for t in TYPES:
            for line in missing[t]:
                print(line)
        for line in bare_detail:
            print(line)
        for line in dead_detail:
            print(line)

    if args.ratchet:
        baseline = load_baseline()
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
        if improved > 0 or bare_improved > 0:
            print(f"\n[OK] 比基线少 {improved} 篇缺导读、少 {bare_improved} 处裸引用。"
                  f"修完记得跑 --update-baseline 把基线压低。")
        else:
            print("\n[OK] 导读欠账与裸引用均未上升，无死链。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
