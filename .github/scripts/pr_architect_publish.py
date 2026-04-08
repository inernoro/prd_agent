#!/usr/bin/env python3
"""Publish PR architect decision card as a single updatable PR comment."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


MARKER_BEGIN = "<!-- pr-architect-decision-card:begin -->"
MARKER_END = "<!-- pr-architect-decision-card:end -->"


def gh_request(token: str, method: str, url: str, payload: dict[str, Any] | None = None) -> Any:
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-architect-publish",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"GitHub API {method} {url} failed: {exc.code} {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub API network error: {exc}") from exc


def load_event() -> tuple[dict[str, Any], str, int]:
    event_path = os.getenv("GITHUB_EVENT_PATH", "").strip()
    if not event_path:
        raise RuntimeError("GITHUB_EVENT_PATH missing")
    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)
    repo = event.get("repository") or {}
    repo_name = str(repo.get("full_name") or "").strip()
    if not repo_name:
        raise RuntimeError("repository.full_name missing in event")
    pr = event.get("pull_request") or {}
    pr_number = pr.get("number")
    if not isinstance(pr_number, int):
        raise RuntimeError("pull_request.number missing in event")
    return event, repo_name, pr_number


def load_result_payload() -> dict[str, Any]:
    path = Path(os.getenv("REVIEW_RUN_PATH", ".github/pr-architect/review-run.json"))
    if not path.exists():
        raise RuntimeError(f"review run artifact missing: {path}")
    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise RuntimeError("review run artifact must be an object")
    return payload


def map_decision(payload: dict[str, Any]) -> str:
    if payload.get("status") == "fail":
        return "Block"
    rec = str(payload.get("recommended_decision") or "").strip()
    if rec in {"Approve", "Approve with Guardrails", "Request Changes", "Block"}:
        return rec
    # fallback for legacy payloads
    score = int(payload.get("risk_score") or 0)
    if score <= 20:
        return "Approve"
    if score <= 39:
        return "Approve with Guardrails"
    return "Request Changes"


def build_guardrails(payload: dict[str, Any], decision: str) -> list[str]:
    if decision != "Approve with Guardrails":
        return []
    return [
        "启用灰度发布（建议先 10%-30% 流量）",
        "设置关键监控阈值并绑定告警接收人",
        "明确回滚触发条件与执行责任人",
    ]


def build_card(payload: dict[str, Any], repo_name: str, pr_number: int) -> str:
    decision = map_decision(payload)
    errors = payload.get("errors") or []
    advisories = payload.get("advisories") or []
    focus = payload.get("focus_questions") or []
    if not isinstance(focus, list):
        focus = []
    focus = [str(item) for item in focus][:3]
    while len(focus) < 3:
        focus.append("N/A")

    metadata_quality = payload.get("metadata_quality") or {}
    completeness = metadata_quality.get("completeness_rate")
    if isinstance(completeness, (int, float)):
        risk_score = int(round((1 - float(completeness)) * 100))
    else:
        risk_score = int(payload.get("risk_score") or 0)
    confidence = int(payload.get("confidence_percent") or (90 if decision in ("Approve", "Block") else 75))
    blockers_triggered = "Yes" if errors else "No"
    guardrails = build_guardrails(payload, decision)

    lines: list[str] = []
    lines.append(MARKER_BEGIN)
    lines.append("## PR 决策卡（自动更新）")
    lines.append("")
    lines.append("### A. 基础信息")
    lines.append(f"- PR: `{repo_name}#{pr_number}`")
    lines.append(f"- `slice_id`: `{payload.get('metadata', {}).get('slice_id', 'N/A')}`")
    lines.append(f"- `bounded_context`: `{payload.get('metadata', {}).get('bounded_context', 'N/A')}`")
    lines.append(f"- `anchor_refs`: `{payload.get('metadata', {}).get('anchor_refs', [])}`")
    lines.append(
        f"- `design_source`: `{payload.get('metadata', {}).get('design_source_id', 'N/A')}@"
        f"{payload.get('metadata', {}).get('design_source_version', 'N/A')}`"
    )
    lines.append("")
    lines.append("### B. 裁决建议")
    lines.append(f"- 建议: `{decision}`")
    lines.append(f"- 风险分: `{risk_score}/100`")
    lines.append(f"- 置信度: `{confidence}%`")
    lines.append(f"- 触发硬阻断: `{blockers_triggered}`")
    if guardrails:
        lines.append("- 护栏建议:")
        for g in guardrails:
            lines.append(f"  - {g}")
    lines.append("")
    lines.append("### C. 阻断项（必须修复）")
    if errors:
        for item in errors:
            lines.append(f"- {item}")
    else:
        lines.append("- None")
    lines.append("")
    lines.append("### D. 风险/建议项")
    if advisories:
        for item in advisories:
            lines.append(f"- {item}")
    else:
        lines.append("- None")
    lines.append("")
    lines.append("### E. 架构师关注问题（最多 3 项）")
    for idx, item in enumerate(focus, start=1):
        lines.append(f"{idx}. {item}")
    lines.append("")
    lines.append("### F. 退回单（当结论不是 Approve 时适用）")
    lines.append("- 结论: `Request Changes` / `Block`")
    lines.append("- 退回类型: `Type A` / `Type B` / `Type C`")
    lines.append("- 重审条件:")
    lines.append("  1. <CHECKABLE_CONDITION_1>")
    lines.append("  2. <CHECKABLE_CONDITION_2>")
    lines.append("")
    lines.append(MARKER_END)
    return "\n".join(lines)


def find_existing_comment(token: str, repo: str, pr_number: int) -> dict[str, Any] | None:
    url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments?per_page=100"
    comments = gh_request(token, "GET", url, None)
    if not isinstance(comments, list):
        return None
    for item in comments:
        if not isinstance(item, dict):
            continue
        body = str(item.get("body") or "")
        if MARKER_BEGIN in body and MARKER_END in body:
            return item
    return None


def upsert_comment(token: str, repo: str, pr_number: int, body: str) -> None:
    existing = find_existing_comment(token, repo, pr_number)
    if existing is None:
        url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
        gh_request(token, "POST", url, {"body": body})
        print("[INFO] created decision card comment")
        return
    comment_id = existing.get("id")
    url = f"https://api.github.com/repos/{repo}/issues/comments/{comment_id}"
    gh_request(token, "PATCH", url, {"body": body})
    print("[INFO] updated decision card comment")


def main() -> int:
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        print("::error::GITHUB_TOKEN missing")
        return 1
    _, repo_name, pr_number = load_event()
    payload = load_result_payload()
    card = build_card(payload, repo_name, pr_number)
    upsert_comment(token, repo_name, pr_number, card)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"::error::pr_architect_publish failed: {exc}")
        raise
