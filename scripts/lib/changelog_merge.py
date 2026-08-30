#!/usr/bin/env python3
"""把碎片条目并进 CHANGELOG.md 的「未发布」段。

为什么单独成文件：assemble-changelog.sh 原来在插入处留了一行注释
「检查 [未发布] 后面是否已有相同日期的条目，如果有则需要合并」，但下面什么都没做——
注释承诺的行为不存在（predicate-and-wiring-discipline 形状 8：拿一份不成立的声明当证据）。
后果不是排版难看：ChangelogReader.ParseChangelogMarkdown 对每个 `### 日期` 都 new 一个
ChangelogDay 并 Add 进 Days，ChangelogPage 遍历时不去重，于是同一天在更新中心渲染成
两组，日期顺序还会从 08-11 跳回 08-22。

抽成模块是为了能被 scripts/tests/test_assemble_changelog_merge.py 直接跑（shell 里内联的
python 没法红绿闭环）。
"""

from __future__ import annotations

import json
import re
import sys

UNRELEASED_RE = re.compile(r"^## \[未发布\]")
RELEASE_RE = re.compile(r"^## \[")
DAY_RE = re.compile(r"^### (\d{4}-\d{2}-\d{2})\s*$")
TABLE_HEAD = "| 类型 | 模块 | 描述 |"
TABLE_SEP = "|------|------|------|"


def _unreleased_bounds(lines: list[str]) -> tuple[int, int]:
    """返回「未发布」段的 [起始行号, 结束行号)；起始行是 `## [未发布]` 那一行本身。"""
    start = next((i for i, l in enumerate(lines) if UNRELEASED_RE.match(l)), None)
    if start is None:
        raise SystemExit("找不到 '## [未发布]' 标记")
    end = next((i for i in range(start + 1, len(lines)) if RELEASE_RE.match(lines[i])), len(lines))
    return start, end


def _day_sections(lines: list[str], start: int, end: int) -> dict[str, tuple[int, int]]:
    """未发布段内每个日期段的 [段首行, 下一段段首行)。同一日期取第一处。"""
    heads = [(i, m.group(1)) for i in range(start, end) if (m := DAY_RE.match(lines[i]))]
    out: dict[str, tuple[int, int]] = {}
    for k, (i, date) in enumerate(heads):
        stop = heads[k + 1][0] if k + 1 < len(heads) else end
        out.setdefault(date, (i, stop))
    return out


def _last_table_row(lines: list[str], i: int, j: int) -> int | None:
    last = None
    for k in range(i, j):
        if lines[k].startswith("|"):
            last = k
    return last


def merge(text: str, payload: dict[str, list[str]]) -> str:
    """payload: {日期: [表格行, ...]}。已有同日期段就并进去，没有才新起一段。"""
    lines = text.split("\n")
    start, end = _unreleased_bounds(lines)
    sections = _day_sections(lines, start, end)

    # 先处理「并入已有段」——从后往前改，避免行号漂移
    existing = sorted(
        ((d, rows) for d, rows in payload.items() if d in sections),
        key=lambda x: sections[x[0]][0],
        reverse=True,
    )
    for date, rows in existing:
        i, j = sections[date]
        anchor = _last_table_row(lines, i, j)
        if anchor is None:
            # 段里只有标题没有表：补一张表
            anchor = i
            rows = [""] + [TABLE_HEAD, TABLE_SEP] + rows
        lines = lines[: anchor + 1] + rows + lines[anchor + 1 :]

    # 再处理「新起一段」——统一插在 `## [未发布]` 之后，日期降序
    fresh = sorted((d for d in payload if d not in sections), reverse=True)
    if fresh:
        block: list[str] = []
        for date in fresh:
            block += ["", f"### {date}", "", TABLE_HEAD, TABLE_SEP] + payload[date]
        # 不再补一行空行：原有正文在 `## [未发布]` 之后本就以空行开头，补了会变成连续两行空行
        start, _ = _unreleased_bounds(lines)
        lines = lines[: start + 1] + block + lines[start + 1 :]

    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: changelog_merge.py <CHANGELOG.md> <payload.json>", file=sys.stderr)
        return 2
    path, payload_path = sys.argv[1], sys.argv[2]
    with open(payload_path, encoding="utf-8") as fh:
        payload = json.load(fh)
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(merge(text, payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
