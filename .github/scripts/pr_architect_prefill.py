#!/usr/bin/env python3
"""PR architect metadata prefill helper.

Prefills section-1 YAML metadata in PR body with repo-bound defaults without
overwriting values already provided by the author.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception as exc:  # pragma: no cover
    print(f"::error::Failed to import PyYAML: {exc}")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
REPO_BINDINGS_PATH = ROOT / ".github/pr-architect/repo-bindings.yml"


def load_yaml(path: Path, label: str) -> dict[str, Any]:
    if not path.exists():
        raise RuntimeError(f"{label} missing: {path}")
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise RuntimeError(f"{label} must be a YAML object: {path}")
    return data


def get_repo_binding(repo_full_name: str, config: dict[str, Any]) -> dict[str, Any]:
    rows = config.get("repositories")
    if not isinstance(rows, list):
        raise RuntimeError("repo-bindings.yml repositories must be a list")
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("repo", "")).strip() == repo_full_name:
            if row.get("enabled") is not True:
                raise RuntimeError(f"repo binding disabled: {repo_full_name}")
            return row
    raise RuntimeError(f"repo binding not found: {repo_full_name}")


def parse_section1_yaml(pr_body: str) -> tuple[dict[str, Any], str, str]:
    # Keep delimiters to replace exactly one section.
    m = re.search(
        r"(##\s*1\)\s*基础元数据（必填）.*?```yaml\s*)(.*?)(\s*```)",
        pr_body,
        flags=re.S,
    )
    if not m:
        raise RuntimeError("failed to find section-1 yaml in PR body")
    prefix, raw_yaml, suffix = m.group(1), m.group(2), m.group(3)
    data = yaml.safe_load(raw_yaml) or {}
    if not isinstance(data, dict):
        raise RuntimeError("section-1 yaml must be an object")
    return data, prefix, suffix


def merge_prefill(
    metadata: dict[str, Any],
    binding: dict[str, Any],
    repo_name: str,
) -> dict[str, Any]:
    merged = dict(metadata)

    required_defaults = {
        "design_source_id": str(binding.get("design_source_id", "")).strip(),
        "design_source_version": str(binding.get("design_source_version", "")).strip(),
        "owner": str(binding.get("default_owner", "")).strip(),
        "bounded_context": str(binding.get("default_context", "")).strip(),
    }
    for key, value in required_defaults.items():
        if not value:
            continue
        if key not in merged or merged.get(key) in ("", None):
            merged[key] = value

    bool_defaults = {
        "out_of_slice_changes": False,
        "contract_change_declared": False,
        "compatibility_plan_attached": False,
        "critical_path_changed": False,
        "skills_traceability_attached": False,
    }
    for key, value in bool_defaults.items():
        if key not in merged:
            merged[key] = value

    if "slice_id" not in merged or not str(merged.get("slice_id", "")).strip():
        merged["slice_id"] = f"repo-{repo_name.replace('/', '-')}-default"

    if "anchor_refs" not in merged or not isinstance(merged.get("anchor_refs"), list):
        anchors = binding.get("default_anchor_refs")
        if isinstance(anchors, list) and anchors:
            merged["anchor_refs"] = anchors
        else:
            merged["anchor_refs"] = []

    if "skills_used" not in merged or not isinstance(merged.get("skills_used"), list):
        merged["skills_used"] = []

    return merged


def should_update(original: dict[str, Any], merged: dict[str, Any]) -> bool:
    return original != merged


def render_yaml_inline(data: dict[str, Any]) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False).rstrip()


def update_pr_body(
    body: str,
    prefix: str,
    suffix: str,
    new_yaml: str,
) -> str:
    pattern = re.compile(
        r"(##\s*1\)\s*基础元数据（必填）.*?```yaml\s*)(.*?)(\s*```)",
        flags=re.S,
    )
    return pattern.sub(lambda _: f"{prefix}{new_yaml}{suffix}", body, count=1)


def github_patch_pr_body(token: str, repo_full_name: str, pr_number: int, new_body: str) -> None:
    url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
    payload = json.dumps({"body": new_body}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pr-architect-prefill",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status < 200 or resp.status >= 300:
                raise RuntimeError(f"GitHub API unexpected status: {resp.status}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"GitHub API HTTPError {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub API URLError: {exc}") from exc


def main() -> int:
    event_path = os.getenv("GITHUB_EVENT_PATH")
    token = os.getenv("GITHUB_TOKEN")
    if not event_path or not token:
        print("::error::GITHUB_EVENT_PATH or GITHUB_TOKEN missing")
        return 1

    with open(event_path, "r", encoding="utf-8") as f:
        event = json.load(f)

    pr = event.get("pull_request") or {}
    repo = event.get("repository") or {}
    repo_full_name = str(repo.get("full_name", "")).strip()
    if not repo_full_name:
        print("::error::repository.full_name missing in event")
        return 1

    pr_number = pr.get("number")
    if not pr_number:
        print("::error::pull_request.number missing in event")
        return 1

    body = str(pr.get("body") or "")
    if not body.strip():
        print("::warning::PR body empty, skip prefill")
        return 0

    config = load_yaml(REPO_BINDINGS_PATH, "repo-bindings")
    binding = get_repo_binding(repo_full_name, config)
    section1, prefix, suffix = parse_section1_yaml(body)
    merged = merge_prefill(section1, binding, repo_full_name)
    if not should_update(section1, merged):
        print("[INFO] no prefill changes needed")
        return 0

    new_body = update_pr_body(body, prefix, suffix, render_yaml_inline(merged))
    dry_run = os.getenv("PREFILL_DRY_RUN", "").strip() == "1"
    out_file = os.getenv("PREFILL_OUTPUT_FILE", "").strip()
    if dry_run:
        if out_file:
            Path(out_file).write_text(new_body, encoding="utf-8")
        print("[INFO] PR body prefill dry-run complete")
        return 0

    github_patch_pr_body(token, repo_full_name, int(pr_number), new_body)
    print("[INFO] PR body prefilled via GitHub REST API")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
