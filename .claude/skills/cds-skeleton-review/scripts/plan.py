#!/usr/bin/env python3
"""Freeze scope and map changed CDS files to registered loading scenes."""

import argparse
from collections import defaultdict
from datetime import date, datetime, time, timedelta
import json
from pathlib import Path
import re
import subprocess
from zoneinfo import ZoneInfo


WEB = "cds/web/src/"
REGISTRY = WEB + "components/skeletons/loading-scenes.json"
SHELL = WEB + "components/layout/AppShell.tsx"


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or f"git {' '.join(args)} 未返回结果")
    return result.stdout.rstrip("\n")


def commit(ref):
    return git("rev-parse", "--verify", f"{ref}^{{commit}}")


def snapshot(sha, file, working=False):
    if working:
        return Path(file).read_text(encoding="utf-8")
    return git("show", f"{sha}:{file}")


def paths_in_diff(*args):
    fields = iter(git("diff", "--name-status", "-z", "--find-renames", *args).split("\0"))
    for status in fields:
        if status:
            yield next(fields)
            if status.startswith(("R", "C")):
                yield next(fields)


def affected_files(base, head, working):
    files = set(paths_in_diff(base, head, "--"))
    if working:
        files.update(paths_in_diff("HEAD", "--"))
        files.update(filter(None, git("ls-files", "--others", "--exclude-standard", "-z").split("\0")))
    return sorted(files)


def day_window(day, timezone, ref):
    start = datetime.combine(day, time.min, tzinfo=timezone)
    end = start + timedelta(days=1)
    anchor = commit(ref)

    def preceding(boundary):
        # Git's --before includes the second named by the argument.
        cutoff = boundary - timedelta(seconds=1)
        sha = git("rev-list", "--first-parent", "-1", f"--before={cutoff.isoformat()}", anchor)
        if not sha:
            raise ValueError(f"{ref} 没有早于 {boundary.isoformat()} 的提交。请核实历史或指定 base/head")
        return sha

    return preceding(start), preceding(end), {"start": start.isoformat(), "end": end.isoformat(), "ref": ref}


def resolve_plan(base, head, working):
    files = affected_files(base, head, working)
    registry = json.loads(snapshot(head, REGISTRY, working))
    shell = snapshot(head, SHELL, working)
    rail = re.search(r"(?ms)^function RailNav\(.*?(?=^(?:export )?function |\Z)", shell)
    sidebar_routes = re.findall(r'\bto="(/[^"#?]+)"', rail[0]) if rail else []
    sidebar = {route: index for index, route in enumerate(dict.fromkeys(sidebar_routes))}
    by_page = defaultdict(list)
    for scene in registry:
        by_page[WEB + scene["page"]].append(scene["route"])

    changed_scenes = defaultdict(list)
    shared = []
    for file in files:
        if file in by_page:
            for route in by_page[file]:
                changed_scenes[route].append(file)
        elif file.startswith(("cds/web/", "cds/src/routes/")) or file == "cds/src/server.ts":
            shared.append(file)

    def priority(scene):
        if scene["route"] in sidebar:
            return 1
        return 3 if scene.get("scope") == "standalone" else 2

    routes = [
        {**scene, "priority": priority(scene), "directChanges": changed_scenes[scene["route"]],
         "sharedReview": bool(shared)}
        for scene in registry if shared or scene["route"] in changed_scenes
    ]
    return {
        "base": base, "head": head, "includesWorktree": working,
        "changedFiles": files, "sharedOrUnmappedFiles": shared,
        "routes": sorted(routes, key=lambda scene: (scene["priority"], sidebar.get(scene["route"], len(sidebar)), scene["route"])),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, help="业务日期 YYYY-MM-DD，默认昨天")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--ref", default="origin/main", help="日期模式读取的分支")
    parser.add_argument("--base", help="自定义范围的起点")
    parser.add_argument("--head", help="自定义范围的终点")
    parser.add_argument("--include-worktree", action="store_true", help="将当前工作区改动纳入显式范围")
    args = parser.parse_args()
    if bool(args.base) != bool(args.head) or args.date and args.base:
        parser.error("请使用 --date 或同时指定 --base、--head")
    if args.include_worktree and not args.head:
        parser.error("--include-worktree 需要显式 --base 和 --head")
    try:
        root = Path(git("rev-parse", "--show-toplevel"))
        if root != Path.cwd():
            raise ValueError(f"请从仓库根目录运行：{root}")
        period = None
        if args.base:
            base, head = commit(args.base), commit(args.head)
        else:
            timezone = ZoneInfo(args.timezone)
            day = args.date or datetime.now(timezone).date() - timedelta(days=1)
            base, head, period = day_window(day, timezone, args.ref)
        if args.include_worktree and head != commit("HEAD"):
            raise ValueError("--include-worktree 要求 --head 与当前 HEAD 相同")
        plan = resolve_plan(base, head, args.include_worktree)
        plan["period"] = period
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, f"范围未生成：{error}\n")
    print(json.dumps(plan, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
