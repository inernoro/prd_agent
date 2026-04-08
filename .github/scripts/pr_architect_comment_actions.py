#!/usr/bin/env python3
"""PR Review Prism slash command actions for Type A/B/C return templates."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


COMMAND_TO_TYPE = {
    "/type-a": "Type A",
    "/type-b": "Type B",
    "/type-c": "Type C",
}


def github_api_request(
    token: str,
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-architect-comment-actions",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            if not body.strip():
                return {}
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"GitHub API HTTPError {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub API URLError: {exc}") from exc


def extract_repo_and_pr(event: dict[str, Any]) -> tuple[str, int]:
    repo = event.get("repository") or {}
    repo_full_name = str(repo.get("full_name") or "").strip()
    issue = event.get("issue") or {}
    pr_number = issue.get("number")
    if not repo_full_name or not isinstance(pr_number, int):
        raise RuntimeError("missing repository.full_name or issue.number")
    return repo_full_name, pr_number


def extract_actor(event: dict[str, Any]) -> str:
    sender = event.get("sender") or {}
    return str(sender.get("login") or "").strip()


def load_repo_binding(repo_full_name: str) -> dict[str, Any]:
    path = ".github/pr-architect/repo-bindings.yml"
    try:
        import yaml  # local import to keep startup light
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"failed to import PyYAML: {exc}") from exc
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    repos = cfg.get("repositories")
    if not isinstance(repos, list):
        raise RuntimeError("repo-bindings.yml repositories must be a list")
    for item in repos:
        if isinstance(item, dict) and str(item.get("repo", "")).strip() == repo_full_name:
            return item
    raise RuntimeError(f"repository binding not found: {repo_full_name}")


def is_actor_authorized(actor: str, binding: dict[str, Any]) -> bool:
    allowed = binding.get("architects")
    if not isinstance(allowed, list):
        return False
    return actor in [str(a).strip() for a in allowed]


def comment_template(return_type: str) -> str:
    return (
        "## PR审查棱镜 退回单\n\n"
        f"- 结论：`Request Changes`\n"
        f"- 退回类型：`{return_type}`\n"
        "- 证据：\n"
        "  1. `<文件/模块/行为>`\n"
        "- 违背点：\n"
        "  1. `<对应 anchor / DDD / slice 约束>`\n"
        "- 期望改法：\n"
        "  1. `<可执行修复动作>`\n"
        "- 重审条件：\n"
        "  1. `<可验证条件 1>`\n"
        "  2. `<可验证条件 2>`\n"
    )


def main() -> int:
    event_path = os.getenv("GITHUB_EVENT_PATH")
    token = os.getenv("GITHUB_TOKEN")
    if not event_path or not token:
        print("::error::GITHUB_EVENT_PATH or GITHUB_TOKEN missing")
        return 1

    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)

    comment = event.get("comment") or {}
    body = str(comment.get("body") or "").strip()
    command = body.splitlines()[0].strip().lower() if body else ""
    if command not in COMMAND_TO_TYPE:
        print("[INFO] no supported slash command found")
        return 0

    repo, pr_number = extract_repo_and_pr(event)
    actor = extract_actor(event)
    binding = load_repo_binding(repo)
    if not is_actor_authorized(actor, binding):
        print(f"[INFO] actor not authorized for slash action: {actor}")
        return 0
    issue_api = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    payload = {"body": comment_template(COMMAND_TO_TYPE[command])}
    github_api_request(token, "POST", issue_api, payload)
    print(f"[INFO] posted return template for {COMMAND_TO_TYPE[command]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
