#!/usr/bin/env python3
"""Build a repository-neutral daily acceptance scope from Git history."""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


HIGH_RISK_RULES = [
    ("身份与权限", re.compile(r"auth|permission|role|token|credential|secret|session", re.I)),
    ("数据与迁移", re.compile(r"migration|schema|database|storage|backup|restore|delete", re.I)),
    ("异步与恢复", re.compile(r"worker|queue|job|retry|timeout|concurr|idempoten", re.I)),
    ("文件与外部输入", re.compile(r"upload|download|file|attachment|archive|zip|import", re.I)),
    ("发布与基础设施", re.compile(r"deploy|release|preview|docker|compose|workflow|infra", re.I)),
    ("公开契约", re.compile(r"api|contract|event|webhook|public|compat", re.I)),
    ("测试与验收", re.compile(r"acceptance|test|spec|e2e|visual|smoke", re.I)),
]


def run(command, cwd):
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=True).stdout


def try_run(command, cwd):
    try:
        return run(command, cwd)
    except Exception:
        return ""


def resolve_timezone(name):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as error:
        raise SystemExit(f"Unknown IANA timezone: {name}") from error


def default_timezone_name():
    configured = os.environ.get("TZ", "").strip()
    if configured:
        try:
            ZoneInfo(configured)
            return configured
        except ZoneInfoNotFoundError:
            pass
    timezone_file = Path("/etc/timezone")
    if timezone_file.is_file():
        candidate = timezone_file.read_text(encoding="utf-8").strip()
        try:
            ZoneInfo(candidate)
            return candidate
        except ZoneInfoNotFoundError:
            pass
    return "UTC"


def repo_root(cwd):
    return Path(run(["git", "rev-parse", "--show-toplevel"], cwd).strip())


def default_branch(root):
    symbolic = try_run(
        ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root
    ).strip()
    if symbolic:
        return symbolic
    remote = try_run(["git", "remote", "show", "origin"], root)
    match = re.search(r"HEAD branch:\s*(\S+)", remote)
    if match:
        return f"origin/{match.group(1)}"
    return ""


def classify_area(path):
    parts = Path(path).parts
    if not parts:
        return "repository-root"
    lowered = path.lower()
    if re.search(r"(^|/)(test|tests|spec|specs|e2e)(/|$)", lowered):
        return "tests"
    if parts[0] in {"docs", "doc"} or lowered.endswith(".md"):
        return "documentation"
    if parts[0] in {".github", ".gitlab", "ci", "deploy", "infra"}:
        return "delivery"
    if len(parts) == 1:
        return "repository-root"
    return parts[0]


def classify_risks(paths, subject):
    haystack = "\n".join(paths) + "\n" + subject
    return [name for name, pattern in HIGH_RISK_RULES if pattern.search(haystack)]


def date_window(date_text, timezone):
    day = dt.date.fromisoformat(date_text)
    start = dt.datetime.combine(day, dt.time.min, timezone)
    return start, start + dt.timedelta(days=1)


def parse_commits(root, start, end):
    output = run(
        [
            "git",
            "log",
            "--all",
            "--no-merges",
            f"--since={start.isoformat()}",
            f"--until={end.isoformat()}",
            "--pretty=format:%H%x09%h%x09%aI%x09%s",
            "--name-only",
        ],
        root,
    )
    commits = []
    current = None
    for raw in output.splitlines():
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
        elif current:
            current["files"].append(line)
    if current:
        commits.append(current)
    for commit in commits:
        commit["areas"] = sorted({classify_area(path) for path in commit["files"]})
        commit["riskTags"] = classify_risks(commit["files"], commit["subject"])
        commit["isHighRisk"] = bool(commit["riskTags"])
    return commits


def summarize_areas(commits):
    summary = {}
    for commit in commits:
        for area in commit["areas"]:
            item = summary.setdefault(area, {"commitCount": 0, "fileCount": 0, "riskTags": set()})
            item["commitCount"] += 1
            item["fileCount"] += sum(1 for path in commit["files"] if classify_area(path) == area)
            item["riskTags"].update(commit["riskTags"])
    return [
        {
            "area": name,
            "commitCount": data["commitCount"],
            "fileCount": data["fileCount"],
            "riskTags": sorted(data["riskTags"]),
        }
        for name, data in sorted(summary.items(), key=lambda pair: (-pair[1]["commitCount"], pair[0]))
    ]


def open_pull_requests(root):
    output = try_run(
        ["gh", "pr", "list", "--state", "open", "--json", "number,title,headRefName,updatedAt,url"],
        root,
    )
    try:
        return json.loads(output) if output.strip() else []
    except json.JSONDecodeError:
        return []


def unpublished_branches(root, base, limit):
    output = try_run(
        [
            "git",
            "for-each-ref",
            "refs/remotes/origin",
            "--format=%(refname:short)\t%(committerdate:iso-strict)\t%(objectname:short)\t%(subject)",
            "--sort=-committerdate",
        ],
        root,
    )
    excluded = {"origin/HEAD", base}
    branches = []
    for line in output.splitlines():
        name, *rest = line.split("\t")
        if name in excluded or len(rest) != 3:
            continue
        branches.append({"name": name, "updatedAt": rest[0], "short": rest[1], "subject": rest[2]})
        if len(branches) >= limit:
            break
    return branches


def render_markdown(scope):
    lines = [
        "# Daily acceptance scope",
        "",
        f"- Target date: {scope['targetDate']}",
        f"- Timezone: {scope['timezone']}",
        f"- Repository: {scope['repo']}",
        f"- Current branch: {scope['currentBranch']}",
        f"- Default branch: {scope['defaultBranch'] or 'not detected'}",
        f"- HEAD: {scope['head']}",
        f"- Commits: {scope['commitCount']}",
        "",
        "## Area summary",
        "",
        "| Area | Commits | Files | Risk tags |",
        "|---|---:|---:|---|",
    ]
    for item in scope["areas"]:
        tags = ", ".join(item["riskTags"]) or "none"
        lines.append(f"| {item['area']} | {item['commitCount']} | {item['fileCount']} | {tags} |")
    lines += ["", "## Commit details", "", "| Commit | Areas | Risks | Subject |", "|---|---|---|---|"]
    for commit in scope["commits"]:
        subject = commit["subject"].replace("|", "\\|")
        lines.append(
            f"| {commit['short']} | {', '.join(commit['areas']) or 'none'} | "
            f"{', '.join(commit['riskTags']) or 'none'} | {subject} |"
        )
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default="", help="Target date in YYYY-MM-DD; defaults to previous local day")
    parser.add_argument("--timezone", default=default_timezone_name(), help="IANA timezone, for example Europe/Paris")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--md-out", default="")
    parser.add_argument("--branch-limit", type=int, default=20)
    args = parser.parse_args()

    timezone = resolve_timezone(args.timezone)
    target_date = args.date or (dt.datetime.now(timezone).date() - dt.timedelta(days=1)).isoformat()
    root = repo_root(args.repo)
    start, end = date_window(target_date, timezone)
    commits = parse_commits(root, start, end)
    base = default_branch(root)
    scope = {
        "targetDate": target_date,
        "timezone": args.timezone,
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "repo": str(root),
        "currentBranch": run(["git", "branch", "--show-current"], root).strip(),
        "defaultBranch": base,
        "head": run(["git", "rev-parse", "--short", "HEAD"], root).strip(),
        "commitCount": len(commits),
        "commits": commits,
        "areas": summarize_areas(commits),
        "openPullRequests": open_pull_requests(root),
        "unpublishedBranches": unpublished_branches(root, base, args.branch_limit),
    }

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(scope, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.md_out:
        Path(args.md_out).write_text(render_markdown(scope), encoding="utf-8")
    if args.json_out or args.md_out:
        print(
            json.dumps(
                {
                    "targetDate": target_date,
                    "timezone": args.timezone,
                    "commitCount": len(commits),
                    "areaCount": len(scope["areas"]),
                    "jsonOut": args.json_out or None,
                    "mdOut": args.md_out or None,
                },
                ensure_ascii=False,
            )
        )
    else:
        print(json.dumps(scope, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
