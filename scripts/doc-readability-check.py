#!/usr/bin/env python3
"""doc/ 说人话导读校验 + 棘轮。

判据 SSOT：doc/rule.doc.readability.md
每篇 doc/*.md 的第一屏必须有「导读三行」：

    **一句话**：……
    **谁该读**：……
    **读完能做什么**：……

本脚本只做机械判定（有没有、是不是人话形状），不判断内容好坏。
存量欠账走棘轮：`scripts/fixtures/doc-readability-baseline.json` 记录当前欠账数，
只许下降不许上升 —— 新文档必须合规，存量走到哪修到哪。

用法：
    python3 scripts/doc-readability-check.py                # 人读报告
    python3 scripts/doc-readability-check.py --list-missing # 只列欠账文件
    python3 scripts/doc-readability-check.py --ratchet      # CI 闸门
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


def load_baseline() -> dict[str, int]:
    if not os.path.exists(BASELINE_PATH):
        return {}
    with open(BASELINE_PATH, encoding="utf-8") as fh:
        return json.load(fh).get("missing", {})


def write_baseline(stats: dict[str, dict[str, int]]) -> None:
    payload = {
        "_comment": (
            "doc/ 导读三行欠账棘轮基线。判据见 doc/rule.doc.readability.md。"
            "数值只许下降：修好存量就跑 --update-baseline 把它压低；"
            "上调必须在 PR 里说明原因，否则一律 reject。"
        ),
        "missing": {t: stats[t]["missing"] for t in TYPES},
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
    args = ap.parse_args()

    stats, missing = scan()
    total = sum(s["total"] for s in stats.values())
    total_missing = sum(s["missing"] for s in stats.values())

    if args.update_baseline:
        write_baseline(stats)
        print(f"基线已更新：{total_missing} / {total} 篇仍欠导读三行")
        return 0

    if args.json:
        print(json.dumps({"stats": stats, "missing": missing}, ensure_ascii=False, indent=2))
        return 0

    print(f"{'类型':<8}{'篇数':>6}{'已达标':>8}{'欠账':>6}{'达标率':>8}")
    for t in TYPES:
        s = stats[t]
        ok = s["total"] - s["missing"]
        rate = f"{ok / s['total'] * 100:.0f}%" if s["total"] else "-"
        print(f"{t:<8}{s['total']:>6}{ok:>8}{s['missing']:>6}{rate:>8}")
    print(f"{'合计':<8}{total:>6}{total - total_missing:>8}{total_missing:>6}"
          f"{(total - total_missing) / total * 100:>7.0f}%")

    if args.list_missing:
        print()
        for t in TYPES:
            for line in missing[t]:
                print(line)

    if args.ratchet:
        baseline = load_baseline()
        if not baseline:
            print("\n[FAIL] 缺基线文件，先跑 --update-baseline", file=sys.stderr)
            return 1
        regressions = []
        for t in TYPES:
            allowed = baseline.get(t, 0)
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
        improved = sum(baseline.get(t, 0) for t in TYPES) - total_missing
        if improved > 0:
            print(f"\n[OK] 欠账比基线少 {improved} 篇。修完记得跑 --update-baseline 把基线压低。")
        else:
            print("\n[OK] 导读欠账未上升。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
