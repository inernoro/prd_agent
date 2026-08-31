#!/usr/bin/env python3
"""scripts/lib/changelog_merge.py 的守卫。

守的是一件在更新中心真会显形的事：CHANGELOG.md 的「未发布」段里出现两个同日期的
`### YYYY-MM-DD`，ChangelogReader.ParseChangelogMarkdown 会为每个头新建一个 ChangelogDay
并 Add 进 Days（不去重），ChangelogPage 遍历时也不合并，于是同一天渲染成两组、日期顺序
从后面那一段往回跳。

红绿闭环怎么做：把 merge() 里「已有同日期段就并进去」那一支改回「一律新起一段」，
下面 test_merges_into_existing_day 必须变红。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))

import os  # noqa: E402
import tempfile  # noqa: E402

import changelog_merge  # noqa: E402
from changelog_merge import merge, plan, write_atomic  # noqa: E402

BASE = """# 更新日志

## [未发布]

### 2026-08-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 已有条目 |

### 2026-08-19

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 更早的条目 |

## [1.9.0] - 2026-05-11

### 2026-05-10

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 已发版的条目 |
"""

FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILURES.append(msg)


def day_headers(text: str, date: str) -> int:
    return sum(1 for line in text.split("\n") if line.strip() == f"### {date}")


def test_merges_into_existing_day() -> None:
    out = merge(BASE, {"2026-08-20": ["| fix | prd-admin | 新并进来的条目 |"]})
    check(day_headers(out, "2026-08-20") == 1, "同日期段被写成了两个 `### 2026-08-20` 头")
    check("新并进来的条目" in out, "新条目没有写进去")
    lines = out.split("\n")
    head = lines.index("### 2026-08-20")
    nxt = lines.index("### 2026-08-19")
    body = "\n".join(lines[head:nxt])
    check("已有条目" in body and "新并进来的条目" in body, "新条目没有落在 2026-08-20 段里")


def test_new_day_goes_to_top_in_desc_order() -> None:
    out = merge(
        BASE,
        {
            "2026-08-30": ["| feat | cds | 最新的一天 |"],
            "2026-08-25": ["| fix | cds | 中间那天 |"],
        },
    )
    lines = [l for l in out.split("\n") if l.startswith("### ")]
    check(
        lines[:4] == ["### 2026-08-30", "### 2026-08-25", "### 2026-08-20", "### 2026-08-19"],
        f"未发布段的日期顺序不是降序：{lines[:4]}",
    )


def test_backfilled_older_date_keeps_descending_order() -> None:
    """补登一个比现有段都旧的日期，不许堆到最前面——那是重复日期段之外的第二种乱序。"""
    out = merge(BASE, {"2026-08-18": ["| fix | cds | 补登的旧日期 |"]})
    lines = [l for l in out.split("\n") if l.startswith("### ")]
    check(
        lines[:3] == ["### 2026-08-20", "### 2026-08-19", "### 2026-08-18"],
        f"补登的旧日期没有落在降序位置：{lines[:3]}",
    )


def test_backfilled_middle_date_lands_between() -> None:
    out = merge(
        BASE,
        {
            "2026-08-22": ["| feat | cds | 比现有段都新 |"],
            "2026-08-19": ["| fix | cds | 并进最旧那一段 |"],
        },
    )
    lines = [l for l in out.split("\n") if l.startswith("### ")]
    check(
        lines[:3] == ["### 2026-08-22", "### 2026-08-20", "### 2026-08-19"],
        f"新日期没有插到正确位置：{lines[:3]}",
    )


def test_dry_run_plan_matches_real_merge() -> None:
    """dry-run 必须走同一条 merge 路径：说「并入」的日期，真跑就不许长出第二个头。"""
    payload = {"2026-08-20": ["| fix | cds | 并入 |"], "2026-08-18": ["| fix | cds | 新建 |"]}
    text = "\n".join(plan(BASE, payload))
    check("2026-08-20  并入已有段" in text, f"dry-run 没把已有日期报成并入：\n{text}")
    check("2026-08-18  新建一段" in text, f"dry-run 没把新日期报成新建：\n{text}")
    out = merge(BASE, payload)
    check(day_headers(out, "2026-08-20") == 1, "真跑与 dry-run 说的不一致：并入的日期长出了第二个头")
    check(day_headers(out, "2026-08-18") == 1, "真跑没有建出新日期段")
    check("日期降序：是" in text, f"dry-run 没报出末态顺序，或末态不降序：\n{text}")


def test_does_not_touch_released_sections() -> None:
    """同一个日期在已发版段里出现过，不能被当成「已有段」并进去。"""
    out = merge(BASE, {"2026-05-10": ["| fix | prd-api | 不该并进已发版那段 |"]})
    lines = out.split("\n")
    unreleased = lines.index("## [未发布]")
    released = lines.index("## [1.9.0] - 2026-05-11")
    check(
        "不该并进已发版那段" in "\n".join(lines[unreleased:released]),
        "新条目被并进了已发版段，或者根本没写进未发布段",
    )
    check(day_headers(out, "2026-05-10") == 2, "已发版段里那个 2026-05-10 头被动过")


def test_write_is_atomic_on_failure() -> None:
    """写到一半失败时，目标文件必须一个字节都没动过（原 shell 是写 .tmp 再 mv 的）。"""
    with tempfile.TemporaryDirectory() as d:
        target = os.path.join(d, "CHANGELOG.md")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(BASE)
        real_replace = changelog_merge.os.replace
        changelog_merge.os.replace = lambda *a, **k: (_ for _ in ()).throw(OSError("磁盘满"))
        try:
            write_atomic(target, "被打断的半截内容")
        except OSError:
            pass
        else:
            FAILURES.append("注入替换失败后 write_atomic 没有抛出")
        finally:
            changelog_merge.os.replace = real_replace
        check(
            open(target, encoding="utf-8").read() == BASE,
            "替换失败后目标文件被改动了——写入不是原子的",
        )
        leftovers = [f for f in os.listdir(d) if f.startswith(".changelog-merge-")]
        check(not leftovers, f"失败后残留了临时文件：{leftovers}")


def test_write_preserves_file_mode() -> None:
    """替换不许把目标文件的权限换成 mkstemp 的 0600（共享工作区里别人就读不到了）。"""
    with tempfile.TemporaryDirectory() as d:
        target = os.path.join(d, "CHANGELOG.md")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(BASE)
        os.chmod(target, 0o644)
        write_atomic(target, BASE + "\n新内容\n")
        mode = os.stat(target).st_mode & 0o7777
        check(mode == 0o644, f"合并后权限从 644 变成了 {oct(mode)}")


def main() -> int:
    for fn in (
        test_merges_into_existing_day,
        test_new_day_goes_to_top_in_desc_order,
        test_backfilled_older_date_keeps_descending_order,
        test_backfilled_middle_date_lands_between,
        test_dry_run_plan_matches_real_merge,
        test_does_not_touch_released_sections,
        test_write_is_atomic_on_failure,
        test_write_preserves_file_mode,
    ):
        fn()
    if FAILURES:
        for f in FAILURES:
            print(f"[FAIL] {f}")
        return 1
    print("[OK] changelog 合并守卫全绿（同日期并段 / 新日期按序插入 / 补登旧日期不乱序 / dry-run 与真跑一致 / 不碰已发版段 / 写入原子 / 权限不变）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
