#!/usr/bin/env python3
"""把 doc/debt.*.md 的债务台账推到任务台。

为什么是这个方向：债务正文的 SSOT 是仓库 —— 它引用文件路径、判据、事故日期，
改代码的那个人顺手改它才对，git diff 是它天然的审阅面。任务台存的是仓库存不住的
那一半：这条债务归谁、什么状态、转成了哪条任务。所以只有「仓库 → 任务台」这一个
方向，没有回写。

稳定标识：`{模块}#{编号}`，模块 = 文件名去掉 `debt.` 前缀和 `.md`，编号 = 表格里那个 `#`。
用编号不用标题做标识，因为标题会被改写（措辞优化、补充说明），编号不会。

列名各家台账不一样（`债务`/`项`、`现状`/`说明`、`补的条件`/`何时必须还`/`建议方案`），
所以按表头映射而不是按列序号硬取 —— 按序号取就是 predicate-and-wiring-discipline
形状 1：换个等价写法判据就失灵。没映射上的列会拼进「现状」，不静默丢内容。

用法：
    python3 scripts/sync-debt-ledger.py --dry-run          # 只打印会推什么
    python3 scripts/sync-debt-ledger.py --base https://... # 真推（需 MAP_AGENT_KEY）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOC_DIR = REPO / "doc"

# 表头 → 字段。同一个字段的多种叫法列在一起，新增叫法往这里加一行即可。
STATUS_HEADERS = {"现状", "说明", "状态"}
CLOSE_HEADERS = {"补的条件", "何时必须还", "建议方案", "关闭条件", "什么时候补"}
# 这些列对「这条债务是什么」没有增量信息，不拼进正文
NOISE_HEADERS = {"优先级", "影响", "负责人", "owner"}

# 只有标题列叫这些名字的编号表，才是「一条条可认领的债务」。
# 其余编号表（文件清单、坑的表、状态对照表）是佐证材料，不是待办。
DEBT_TITLE_HEADERS = {"债务", "项", "事项", "欠什么", "缺口"}


def split_row(line: str) -> list[str]:
    """切一行 Markdown 表格。首尾的空段是分隔符产生的，去掉。"""
    cells = [c.strip() for c in line.split("|")]
    if cells and cells[0] == "":
        cells = cells[1:]
    if cells and cells[-1] == "":
        cells = cells[:-1]
    return cells


def is_separator(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{2,}:?", c) for c in cells)


def parse_ledger(path: Path) -> tuple[list[dict], list[str]]:
    """解析一份台账，返回（条目, 说明）。说明是给人看的列映射结果。

    **一份台账只取一张主表。** 这不是偷懒，是被真实数据逼出来的：`debt.cds.md`
    一份里有十几张以 `#` 打头的编号表，每张都从 1 开始编，如果全收，`cds#1`
    就会被十几行争抢，同步时互相覆盖 —— 而且那十几张表里多数根本不是待办
    （文件清单、坑的对照表、状态表），塞进债务区只是噪音。

    主表的判据：第一列是 `#`，且标题列名在 DEBT_TITLE_HEADERS 里。命中第一张就收，
    后面的编号表一律跳过并在说明里报出来，不静默丢。
    """
    module = path.name[len("debt."):-len(".md")]
    lines = path.read_text(encoding="utf-8").splitlines()

    header: list[str] | None = None
    notes: list[str] = []
    items: list[dict] = []
    taken = False     # 主表是否已经收过
    skipped_tables = 0

    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            # 表格断了就重置表头 —— 一份台账里可能有好几张表
            header = None
            continue

        cells = split_row(stripped)
        if not cells:
            continue
        if is_separator(cells):
            continue

        if header is None:
            # 只认第一列是 # 的表；别的表（对照表、事故台账）不是债务条目
            if cells[0] in ("#", "＃"):
                title_col = cells[1] if len(cells) > 1 else ""
                if taken or title_col not in DEBT_TITLE_HEADERS:
                    skipped_tables += 1
                    continue
                taken = True
                header = cells
                status_cols = [h for h in header[2:] if h in STATUS_HEADERS]
                close_cols = [h for h in header[2:] if h in CLOSE_HEADERS]
                extra = [h for h in header[2:]
                         if h not in STATUS_HEADERS and h not in CLOSE_HEADERS and h not in NOISE_HEADERS]
                notes.append(
                    f"{path.name}: 标题列「{title_col}」"
                    f" / 现状列 {status_cols or '无'}"
                    f" / 条件列 {close_cols or '无'}"
                    + (f" / 并入现状 {extra}" if extra else "")
                )
            continue

        # 到这里是数据行：第一列必须是纯数字，否则不是债务条目
        if not re.fullmatch(r"\d{1,4}", cells[0]):
            continue
        num = int(cells[0])
        if num <= 0:
            continue

        title = cells[1] if len(cells) > 1 else ""
        if not title:
            continue

        status_parts, close_parts = [], []
        for idx, head in enumerate(header[2:], start=2):
            if idx >= len(cells):
                break
            value = cells[idx]
            if not value:
                continue
            if head in CLOSE_HEADERS:
                close_parts.append(value)
            elif head in STATUS_HEADERS:
                status_parts.append(value)
            elif head not in NOISE_HEADERS:
                # 没映射上的列不丢，带上列名拼进现状
                status_parts.append(f"{head}：{value}")

        items.append({
            "key": f"{module}#{num}",
            "title": title,
            "status": "\n".join(status_parts) or None,
            "closeCondition": "\n".join(close_parts) or None,
            "sourcePath": f"doc/{path.name}",
        })

    if skipped_tables:
        notes.append(f"{path.name}: 跳过 {skipped_tables} 张非主表的编号表（标题列不在 {sorted(DEBT_TITLE_HEADERS)} 里，或主表已取）")
    if not taken:
        notes.append(f"{path.name}: 没有主表 —— 这份台账是纯叙述，或者标题列的叫法还没登记进 DEBT_TITLE_HEADERS")

    return items, notes


def collect() -> tuple[list[dict], list[str], list[str]]:
    all_items: list[dict] = []
    all_notes: list[str] = []
    for path in sorted(DOC_DIR.glob("debt.*.md")):
        items, notes = parse_ledger(path)
        all_items.extend(items)
        all_notes.extend(notes)

    # key 撞车 = 同步时互相覆盖，而且是静默的。宁可整轮失败也不许推上去。
    seen: dict[str, str] = {}
    clashes: list[str] = []
    for item in all_items:
        prev = seen.get(item["key"])
        if prev is not None:
            clashes.append(f"{item['key']} 同时来自「{prev}」和「{item['title'][:30]}」")
        seen[item["key"]] = item["title"][:30]
    return all_items, all_notes, clashes


def push(base: str, key: str, items: list[dict], batch: int = 200) -> int:
    url = base.rstrip("/") + "/api/open/tasks/debts/sync"
    created = updated = 0
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        body = json.dumps({"items": chunk}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {key}")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            print(f"[失败] HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:400]}", file=sys.stderr)
            return 2
        data = payload.get("data") or {}
        created += data.get("created", 0)
        updated += data.get("updated", 0)
        for line in data.get("skipped") or []:
            print(f"  [跳过] {line}")
    print(f"[完成] 新建 {created} 条，更新 {updated} 条；认领人与状态未受影响")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="把 doc/debt.*.md 推到任务台的债务区")
    ap.add_argument("--base", default=os.environ.get("MAP_BASE", ""), help="MAP 站点地址")
    ap.add_argument("--key-env", default="MAP_AGENT_KEY", help="装着 Agent Key 的环境变量名")
    ap.add_argument("--dry-run", action="store_true", help="只打印会推什么，不发请求")
    args = ap.parse_args()

    items, notes, clashes = collect()
    print(f"扫到 {len(items)} 条债务，来自 {len(set(i['key'].split('#')[0] for i in items))} 份台账")
    for line in notes:
        print(f"  {line}")

    if clashes:
        print(f"[失败] {len(clashes)} 个标识撞车 —— 推上去会互相覆盖，先修台账：", file=sys.stderr)
        for line in clashes[:20]:
            print(f"  {line}", file=sys.stderr)
        return 2

    if not items:
        print("没有可推的条目 —— 检查一下 doc/debt.*.md 里的表是不是第一列写着 #")
        return 1

    if args.dry_run:
        for item in items[:10]:
            print(f"  {item['key']}  {item['title'][:60]}")
        if len(items) > 10:
            print(f"  ...（其余 {len(items) - 10} 条）")
        return 0

    if not args.base:
        print("缺 --base（或环境变量 MAP_BASE）", file=sys.stderr)
        return 1
    key = os.environ.get(args.key_env, "").strip()
    if not key:
        print(f"缺环境变量 {args.key_env}（Agent Key，别写进命令行）", file=sys.stderr)
        return 1
    return push(args.base, key, items)


if __name__ == "__main__":
    sys.exit(main())
