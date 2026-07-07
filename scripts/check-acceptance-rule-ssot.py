#!/usr/bin/env python3
"""Validate the acceptance-rule SSOT wiring.

This check keeps repository docs, skill fallback snapshots, official skill
bundles, and CDS publishing from drifting into separate rule copies.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

SOURCE_DOCS = [
    "doc/rule.acceptance.map-enterprise.md",
    "doc/rule.acceptance.ssot.md",
    "doc/guide.acceptance.daily-sop.md",
    "doc/guide.acceptance.report-evidence.md",
    "doc/design.acceptance.knowledge-governance.md",
]

SKILLS = [
    "acceptance-test-design",
    "acceptance-scenario-orchestrator",
    "create-visual-test-to-kb",
]

SNAPSHOTS = [
    "rule.acceptance.map-enterprise.md",
    "rule.acceptance.ssot.md",
    "guide.acceptance.daily-sop.md",
    "guide.acceptance.report-evidence.md",
    "design.acceptance.knowledge-governance.md",
]

DOC_HEADER_RE = re.compile(
    r"^# .+\n\n> \*\*版本\*\*：v[0-9.]+ \| \*\*日期\*\*：\d{4}-\d{2}-\d{2} \| \*\*状态\*\*："
    r"(草案|规划中|开发中|已落地|已废弃)",
    re.M,
)


def fail(message: str) -> None:
    raise SystemExit(message)


def rel(path: str) -> Path:
    return ROOT / path


def require_file(path: str) -> None:
    if not rel(path).is_file():
        fail(f"missing file: {path}")


def require_contains(path: str, needle: str) -> None:
    text = rel(path).read_text(encoding="utf-8")
    if needle not in text:
        fail(f"{path} missing required text: {needle}")


def require_doc_header(path: str) -> None:
    text = rel(path).read_text(encoding="utf-8")
    if not DOC_HEADER_RE.search(text):
        fail(f"{path} missing required doc metadata header: 版本 | 日期 | 状态")


def run_snapshot_check() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/sync-acceptance-rule-snapshots.py", "--check"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if proc.returncode != 0:
        fail(proc.stdout.strip() or "snapshot check failed")


def check_official_catalog() -> None:
    path = rel("prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json")
    if not path.is_file():
        return
    catalog = json.loads(path.read_text(encoding="utf-8"))
    by_key = {item.get("key"): item for item in catalog.get("skills", [])}
    for skill in SKILLS:
        item = by_key.get(skill)
        if not item:
            fail(f"official catalog missing skill: {skill}")
        files_by_path = {f.get("path"): f for f in item.get("files", [])}
        if "references/rules/manifest.json" not in files_by_path:
            fail(f"official catalog missing rules manifest: {skill}")
        for embedded_path in ["references/rules/manifest.json", *[f"references/rules/{s}" for s in SNAPSHOTS]]:
            file_entry = files_by_path.get(embedded_path)
            if not file_entry:
                fail(f"official catalog missing rules snapshot: {skill}/{embedded_path}")
            if file_entry.get("truncated"):
                fail(f"official catalog embedded rule file is truncated: {skill}/{embedded_path}")
            disk_text = rel(f".claude/skills/{skill}/{embedded_path}").read_text(encoding="utf-8")
            if file_entry.get("content") != disk_text:
                fail(f"official catalog stale embedded rule snapshot: {skill}/{embedded_path}")


def main() -> None:
    for path in SOURCE_DOCS:
        require_file(path)
        require_doc_header(path)
        key = Path(path).with_suffix("").name
        require_contains("doc/index.yml", key)
        require_contains("doc/guide.list.directory.md", key)

    for skill in SKILLS:
        skill_md = f".claude/skills/{skill}/SKILL.md"
        require_file(skill_md)
        require_contains(skill_md, "references/rules")
        require_contains(skill_md, "doc/rule.acceptance.map-enterprise.md")
        rules_dir = rel(f".claude/skills/{skill}/references/rules")
        require_file(str(rules_dir.relative_to(ROOT) / "manifest.json"))
        for snapshot in SNAPSHOTS:
            require_file(str(rules_dir.relative_to(ROOT) / snapshot))

    require_file(".claude/skills/create-visual-test-to-kb/scripts/publish_acceptance_rules_to_cds.py")
    if rel(".claude/skills/create-visual-test-to-kb/scripts/restyle_method_docs.py").exists():
        fail("restyle_method_docs.py must not exist; publish Markdown from repo docs instead")

    run_snapshot_check()
    check_official_catalog()
    print("acceptance rule SSOT wiring is valid")


if __name__ == "__main__":
    main()
