#!/usr/bin/env python3
"""Daily acceptance scope inventory.

Collects the previous day's git changes into a machine-readable scope file for
acceptance-test-design. The script is intentionally conservative: it classifies
modules and risk from changed paths, but it does not decide pass/fail.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo


TZ = ZoneInfo("Asia/Shanghai")

MODULE_RULES = [
    ("prd-api", re.compile(r"^prd-api/")),
    ("prd-admin", re.compile(r"^prd-admin/")),
    ("prd-desktop", re.compile(r"^prd-desktop/")),
    ("prd-video", re.compile(r"^prd-video/")),
    ("cds", re.compile(r"^(cds/|cds-compose\.yml)")),
    ("验收技能", re.compile(r"^\.claude/skills/(acceptance|create-visual)|^\.agents/skills/(acceptance|create-visual)")),
    ("文档", re.compile(r"^(doc/|AGENTS\.md|CLAUDE\.md)")),
    ("更新记录", re.compile(r"^changelogs/")),
]

HIGH_RISK_RULES = [
    ("鉴权/权限", re.compile(r"auth|permission|role|token|jwt|access-key|impersonate", re.I)),
    ("异步/队列/Worker", re.compile(r"worker|queue|job|run|background|poll|retry|dispatcher", re.I)),
    ("上传/文件/压缩", re.compile(r"upload|file|attachment|compress|zip|asset|blob", re.I)),
    ("外部下载/生成", re.compile(r"download|external|douyin|video|remotion|model|llm|gateway", re.I)),
    ("部署/预览", re.compile(r"cds|deploy|preview|compose|docker|canary", re.I)),
    ("状态流转/恢复/同步", re.compile(r"sync|restore|state|status|transition|document-store|knowledge", re.I)),
    ("验收链路", re.compile(r"acceptance|visual-test|verify-open|archive_report|harness", re.I)),
]


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=True).stdout


def try_run(cmd, cwd):
    try:
        return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=True).stdout
    except Exception:
        return ""


def repo_root(cwd):
    return Path(run(["git", "rev-parse", "--show-toplevel"], cwd).strip())


def default_target_date():
    return (dt.datetime.now(TZ).date() - dt.timedelta(days=1)).isoformat()


def date_window(date_text):
    day = dt.date.fromisoformat(date_text)
    start = dt.datetime.combine(day, dt.time.min, TZ)
    end = start + dt.timedelta(days=1)
    return start, end


def classify_module(path):
    for name, pattern in MODULE_RULES:
        if pattern.search(path):
            return name
    return "其他"


def classify_risks(paths, subject):
    hay = "\n".join(paths) + "\n" + subject
    return [name for name, pattern in HIGH_RISK_RULES if pattern.search(hay)]


def parse_commits(root, start, end):
    fmt = "%H%x09%h%x09%aI%x09%s"
    out = run([
        "git", "log", "--all", "--no-merges",
        f"--since={start.isoformat()}",
        f"--until={end.isoformat()}",
        f"--pretty=format:{fmt}",
        "--name-only",
    ], root)
    commits = []
    current = None
    for raw in out.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) == 4 and re.fullmatch(r"[0-9a-f]{40}", parts[0]):
            if current:
                commits.append(current)
            current = {
                "sha": parts[0],
                "short": parts[1],
                "authorDate": parts[2],
                "subject": parts[3],
                "files": [],
            }
            continue
        if current:
            current["files"].append(line)
    if current:
        commits.append(current)
    for c in commits:
        modules = sorted({classify_module(p) for p in c["files"]})
        risks = classify_risks(c["files"], c["subject"])
        c["modules"] = modules
        c["riskTags"] = risks
        c["isHighRisk"] = bool(risks)
    return commits


def summarize_modules(commits):
    modules = {}
    for c in commits:
        for m in c["modules"]:
            item = modules.setdefault(m, {"commitCount": 0, "fileCount": 0, "highRiskTags": set()})
            item["commitCount"] += 1
            item["fileCount"] += sum(1 for p in c["files"] if classify_module(p) == m)
            item["highRiskTags"].update(c["riskTags"])
    return [
        {
            "module": name,
            "commitCount": data["commitCount"],
            "fileCount": data["fileCount"],
            "highRiskTags": sorted(data["highRiskTags"]),
        }
        for name, data in sorted(modules.items(), key=lambda kv: (-kv[1]["commitCount"], kv[0]))
    ]


def open_prs(root):
    out = try_run([
        "gh", "pr", "list", "--state", "open",
        "--json", "number,title,headRefName,updatedAt,url",
    ], root)
    if not out.strip():
        return []
    try:
        return json.loads(out)
    except Exception:
        return []


def unpublished_branches(root, limit):
    out = try_run([
        "git", "for-each-ref", "refs/remotes/origin",
        "--format=%(refname:short)\t%(committerdate:iso-strict)\t%(objectname:short)\t%(subject)",
        "--sort=-committerdate",
    ], root)
    branches = []
    for line in out.splitlines():
        name, *rest = line.split("\t")
        if name in {"origin/HEAD", "origin/main", "origin/master"}:
            continue
        if len(rest) != 3:
            continue
        branches.append({"name": name, "updatedAt": rest[0], "short": rest[1], "subject": rest[2]})
        if len(branches) >= limit:
            break
    return branches


def render_markdown(scope):
    lines = [
        "# 每日验收范围盘点",
        "",
        f"- 目标日期: {scope['targetDate']}",
        f"- 时区: {scope['timezone']}",
        f"- 仓库: {scope['repo']}",
        f"- 当前分支: {scope['currentBranch']}",
        f"- HEAD: {scope['head']}",
        f"- commit 数: {scope['commitCount']}",
        f"- open PR 数: {len(scope['openPullRequests'])}",
        f"- 未发布远端分支采样数: {len(scope['unpublishedBranches'])}",
        "",
        "## 模块汇总",
        "",
        "| 模块 | commit 数 | 文件数 | 高风险标签 |",
        "|---|---:|---:|---|",
    ]
    for m in scope["modules"]:
        tags = "、".join(m["highRiskTags"]) if m["highRiskTags"] else "无"
        lines.append(f"| {m['module']} | {m['commitCount']} | {m['fileCount']} | {tags} |")
    lines += ["", "## Commit 明细", "", "| commit | 模块 | 高风险 | 标题 |", "|---|---|---|---|"]
    for c in scope["commits"]:
        modules = "、".join(c["modules"]) if c["modules"] else "无"
        risks = "、".join(c["riskTags"]) if c["riskTags"] else "无"
        subject = c["subject"].replace("|", "\\|")
        lines.append(f"| {c['short']} | {modules} | {risks} | {subject} |")
    lines += ["", "## 未发布状态", "", "| 分支 | 更新时间 | HEAD | 标题 |", "|---|---|---|---|"]
    for b in scope["unpublishedBranches"]:
        subject = b["subject"].replace("|", "\\|")
        lines.append(f"| {b['name']} | {b['updatedAt']} | {b['short']} | {subject} |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=default_target_date(), help="Asia/Shanghai target date, YYYY-MM-DD")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--md-out", default="")
    parser.add_argument("--branch-limit", type=int, default=20)
    args = parser.parse_args()

    root = repo_root(args.repo)
    start, end = date_window(args.date)
    commits = parse_commits(root, start, end)
    head = run(["git", "rev-parse", "--short", "HEAD"], root).strip()
    branch = run(["git", "branch", "--show-current"], root).strip()
    scope = {
        "targetDate": args.date,
        "timezone": "Asia/Shanghai",
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "repo": str(root),
        "currentBranch": branch,
        "head": head,
        "commitCount": len(commits),
        "commits": commits,
        "modules": summarize_modules(commits),
        "openPullRequests": open_prs(root),
        "unpublishedBranches": unpublished_branches(root, args.branch_limit),
    }

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(scope, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.md_out:
        Path(args.md_out).write_text(render_markdown(scope), encoding="utf-8")
    if not args.json_out and not args.md_out:
        print(json.dumps(scope, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({
            "targetDate": scope["targetDate"],
            "commitCount": scope["commitCount"],
            "moduleCount": len(scope["modules"]),
            "openPullRequestCount": len(scope["openPullRequests"]),
            "unpublishedBranchCount": len(scope["unpublishedBranches"]),
            "jsonOut": args.json_out or None,
            "mdOut": args.md_out or None,
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
