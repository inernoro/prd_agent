#!/usr/bin/env python3
"""守 scripts/sync-debt-ledger.py 的三条不变量。

为什么这三条：这个解析器一旦漂了，症状全是**静默**的 —— 要么少推一批债务
（没人发现，因为界面上本来就没有它们），要么标识撞车让两条债务在同步时互相覆盖
（也没人发现，因为覆盖不报错）。所以判据必须机械、能变红。

1. 标识全局唯一 —— 撞车就是静默互相覆盖，这是最贵的那种坏
2. 标识格式与后端正则同源 —— 后端不认的 key 推上去只会被整批跳过
3. 一份台账只取一张主表 —— debt.cds.md 有十几张编号表，全收必撞车
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SCRIPT = REPO / "scripts" / "sync-debt-ledger.py"

# 与 ActiveTaskDebtsController.ParseKey 同一条正则。两边任一侧改了这里就该红。
BACKEND_KEY_PATTERN = re.compile(r"^([a-z0-9]+(?:[.\-][a-z0-9]+)*)#(\d{1,4})$")

failures: list[str] = []


def load():
    spec = importlib.util.spec_from_file_location("sync_debt_ledger", SCRIPT)
    assert spec and spec.loader, f"载入不了 {SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(label: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  [通过] {label}")
    else:
        failures.append(f"{label}：{detail}")
        print(f"  [失败] {label}：{detail}")


def main() -> int:
    if not SCRIPT.exists():
        print(f"[失败] 找不到被测脚本 {SCRIPT}")
        return 1

    mod = load()
    items, notes, clashes = mod.collect()

    # 0. 先确认真的扫到了东西 —— 解析器全线失灵时前三条判据都会「空过」
    check("扫到了债务条目（防空跑）", len(items) > 0,
          f"一条都没扫到；仓库里有 {len(list((REPO / 'doc').glob('debt.*.md')))} 份 debt.*.md")
    if not items:
        return 1

    # 1. 标识全局唯一
    check("标识全局唯一", not clashes,
          f"{len(clashes)} 个撞车，例如 {clashes[0] if clashes else ''}")

    # 2. 标识格式后端认得
    bad = [i["key"] for i in items if not BACKEND_KEY_PATTERN.match(i["key"])]
    check("标识格式与后端 ParseKey 同源", not bad,
          f"{len(bad)} 个后端不认，例如 {bad[:3]}")

    # 3. 一份台账只取一张主表。
    #    机械判法：同一个模块内编号不许重复 —— 跨表叠加必然产生重复，因为每张表
    #    都是从 1 开始编的。这条和第 1 条不是同义反复：第 1 条看的是全局 key，
    #    这条看的是模块内编号，前者被改成带表号的 key 之后仍然全绿，这条才会红。
    #    （写这条时第一版判据是「最大编号不超过条数两倍」，实测拆掉主表判据后它
    #    照样绿 —— 那是一条说自己在测 A、实际在测 B 的假绿判据，已重写。）
    by_module: dict[str, list[int]] = {}
    for item in items:
        module, num = item["key"].split("#")
        by_module.setdefault(module, []).append(int(num))
    dupes = [
        f"{m}: 编号 {sorted(n for n in set(nums) if nums.count(n) > 1)[:5]} 重复"
        for m, nums in by_module.items()
        if len(nums) != len(set(nums))
    ]
    check("每份台账只收了一张主表（模块内编号不重复）", not dupes, "; ".join(dupes[:3]))

    # 4. 必填字段齐 —— title 为空的条目会被后端整条跳过，等于白推
    empty = [i["key"] for i in items if not (i.get("title") or "").strip()]
    check("每条都有标题", not empty, f"{len(empty)} 条无标题，例如 {empty[:3]}")

    # 4.5 表格行不许折行。
    #     markdown 表格一行必须是一行：中间换一次行，解析器从那行起就停了，
    #     后面的条目**静默消失**，而上面几条判据全绿（少 7 条既不算空、也不撞车、
    #     也不缺标题）。2026-09-16 我自己给第 13 条补说明时把一行拆成两行，
    #     总数从 108 掉到 101，一条判据都没红 —— 这条就是补那个洞的。
    #     判法：非空行以 | 结尾却不以 | 开头 = 上一行的续行。
    wrapped = []
    for path in sorted((REPO / "doc").glob("debt.*.md")):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            t = line.strip()
            if t.endswith("|") and not t.startswith("|"):
                wrapped.append(f"{path.name}:{lineno}")
    check("台账里没有折行的表格行", not wrapped,
          f"{len(wrapped)} 处折行，例如 {wrapped[:3]} —— 折行之后的条目会被静默丢掉")

    # 5. 被测输入都登记进了 CI 的 path filter（形状 7：守卫自己没接上线）。
    #    被测输入是两样：解析器本身，和它读的那些台账。只登记解析器的话，
    #    「只改一份台账」的 PR 照样跳过这道闸 —— 而撞车的标识、认不出的表头、
    #    解析成空，恰恰都是在台账那边长出来的（2026-09-16 Codex 抓到，这条守卫
    #    自己就有它要防的那个洞）。
    ci = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    check("解析器登记进了 ci.yml 的 path filter",
          "scripts/sync-debt-ledger.py" in ci,
          "只改 sync-debt-ledger.py 的 PR 不会触发这道闸")
    check("台账本身也登记进了 ci.yml 的 path filter",
          "doc/debt.*.md" in ci,
          "只改一份 doc/debt.*.md 的 PR 不会触发这道闸，而它正是撞车与表头漂移的来源")

    print(f"\n扫到 {len(items)} 条债务，来自 {len(by_module)} 份台账")
    if failures:
        print(f"\n[失败] {len(failures)} 条判据没过：")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("[通过] 债务台账解析器全部判据通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
