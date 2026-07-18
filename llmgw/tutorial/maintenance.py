#!/usr/bin/env python3
"""生成 LLMGW 权威教程的每日漂移报告，不自动修改正文或远端知识库。"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
from pathlib import Path
import subprocess
import sys
from typing import Any


TUTORIAL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TUTORIAL_ROOT.parents[1]
DEFAULT_MAP = TUTORIAL_ROOT / "maintenance-map.json"
DEFAULT_MANIFEST = TUTORIAL_ROOT / "manifest.json"
PAGE_GLOB = "llmgw/web/src/pages/*.tsx"


class MaintenanceError(RuntimeError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MaintenanceError(f"无法读取 {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MaintenanceError(f"{path} 顶层必须是对象")
    return value


def changed_files(repo_root: Path, since: str, base_ref: str | None) -> list[str]:
    if base_ref:
        command = ["git", "diff", "--name-only", f"{base_ref}...HEAD"]
    else:
        command = ["git", "log", f"--since={since}", "--name-only", "--pretty=format:"]
    try:
        output = subprocess.check_output(command, cwd=repo_root, text=True, stderr=subprocess.STDOUT)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "output", "")
        raise MaintenanceError(f"无法计算教程增量: {detail or exc}") from exc
    return sorted({line.strip() for line in output.splitlines() if line.strip()})


def _manifest_sources(manifest: dict[str, Any]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for node in manifest.get("nodes", []):
        if not isinstance(node, dict) or node.get("kind") != "document":
            continue
        source_id = node.get("sourceId")
        source_path = node.get("sourcePath")
        if isinstance(source_id, str) and isinstance(source_path, str):
            result[source_id] = TUTORIAL_ROOT / source_path
    return result


def analyze(
    repo_root: Path,
    mapping: dict[str, Any],
    manifest: dict[str, Any],
    files: list[str],
    now: dt.datetime,
) -> dict[str, Any]:
    if mapping.get("schemaVersion") != 1:
        raise MaintenanceError("maintenance-map.schemaVersion 必须为 1")
    surfaces = mapping.get("surfaces")
    if not isinstance(surfaces, list):
        raise MaintenanceError("maintenance-map.surfaces 必须是数组")

    by_page: dict[str, dict[str, Any]] = {}
    for surface in surfaces:
        if not isinstance(surface, dict) or not isinstance(surface.get("pagePath"), str):
            raise MaintenanceError("每个教程 surface 必须声明 pagePath")
        page_path = surface["pagePath"]
        if page_path in by_page:
            raise MaintenanceError(f"页面映射重复: {page_path}")
        by_page[page_path] = surface

    sources = _manifest_sources(manifest)
    changed_pages = sorted(path for path in files if fnmatch.fnmatch(path, PAGE_GLOB))
    changed_tutorial_sources = {
        source_id
        for source_id, path in sources.items()
        if str(path.relative_to(repo_root)) in files
    }
    findings: list[dict[str, str]] = []
    affected: list[dict[str, Any]] = []

    for page_path in changed_pages:
        surface = by_page.get(page_path)
        if surface is None:
            findings.append({
                "severity": "P1",
                "surface": page_path,
                "message": "页面发生变化，但 maintenance-map 没有对应教程章节",
            })
            continue
        source_ids = surface.get("tutorialSourceIds")
        if not isinstance(source_ids, list) or not source_ids:
            raise MaintenanceError(f"{surface.get('id')}: tutorialSourceIds 不能为空")
        affected.append({
            "surface": str(surface.get("id")),
            "pagePath": page_path,
            "tutorialSourceIds": source_ids,
            "tutorialChanged": any(source_id in changed_tutorial_sources for source_id in source_ids),
        })
        product_path = repo_root / page_path
        product_text = product_path.read_text(encoding="utf-8") if product_path.is_file() else ""
        if not product_text:
            findings.append({
                "severity": "P0",
                "surface": str(surface.get("id")),
                "message": f"映射页面不存在或为空: {page_path}",
            })
            continue
        tutorial_texts: list[str] = []
        for source_id in source_ids:
            source_path = sources.get(source_id)
            if source_path is None or not source_path.is_file():
                findings.append({
                    "severity": "P0",
                    "surface": str(surface.get("id")),
                    "message": f"映射章节不存在: {source_id}",
                })
            else:
                tutorial_texts.append(source_path.read_text(encoding="utf-8"))
        tutorial_text = "\n".join(tutorial_texts)
        for anchor in surface.get("anchors", []):
            if not isinstance(anchor, dict):
                raise MaintenanceError(f"{surface.get('id')}: anchor 必须是对象")
            name = str(anchor.get("name") or "未命名锚点")
            product_marker = str(anchor.get("product") or "")
            tutorial_marker = str(anchor.get("tutorial") or "")
            if not product_marker or product_marker not in product_text:
                findings.append({
                    "severity": "P0",
                    "surface": str(surface.get("id")),
                    "message": f"稳定页面锚点已消失: {name}",
                })
            elif not tutorial_marker or tutorial_marker not in tutorial_text:
                findings.append({
                    "severity": "P1",
                    "surface": str(surface.get("id")),
                    "message": f"页面能力存在但教程缺少对应说明: {name}",
                })

    week = now.isocalendar()
    drafts = [
        {
            "sourceId": f"{item['surface']}-update-{week.year}w{week.week:02d}",
            "tier": "advanced",
            "status": "draft",
            "tutorialSourceIds": item["tutorialSourceIds"],
            "summary": "页面本周发生变化，请人工确认是否需要发布更新提醒。",
        }
        for item in affected
    ]
    status = "drift" if findings else "healthy"
    return {
        "schemaVersion": 1,
        "generatedAt": now.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": status,
        "changedFiles": files,
        "changedPages": changed_pages,
        "affectedTutorials": affected,
        "findings": findings,
        "updateDrafts": drafts,
        "policy": "report-only-no-automatic-content-or-seed-update",
    }


def render_markdown(report: dict[str, Any]) -> str:
    status = "正常" if report["status"] == "healthy" else "有漂移"
    lines = [
        f"# [{status}] LLMGW 教程巡检",
        "",
        f"生成时间：{report['generatedAt']}",
        "",
        "## 受影响教程",
        "",
    ]
    affected = report["affectedTutorials"]
    if affected:
        for item in affected:
            chapters = ", ".join(item["tutorialSourceIds"])
            synced = "本次已同步正文" if item["tutorialChanged"] else "待人工确认正文是否需更新"
            lines.append(f"- {item['surface']}: {chapters}; {synced}")
    else:
        lines.append("- 本次没有 LLMGW 页面增量")
    lines.extend(["", "## 漂移告警", ""])
    if report["findings"]:
        for finding in report["findings"]:
            lines.append(f"- [{finding['severity']}] {finding['surface']}: {finding['message']}")
    else:
        lines.append("- P0/P1/P2 均为 0")
    lines.extend(["", "## 本周更新提醒草稿", ""])
    if report["updateDrafts"]:
        for draft in report["updateDrafts"]:
            lines.append(f"- {draft['sourceId']}: {draft['summary']}")
    else:
        lines.append("- 无")
    lines.extend([
        "",
        "## 执行边界",
        "",
        "本报告只做漂移检测和更新提醒起草，不自动修改教程正文、DailyTips seed 或远端知识库。",
        "",
    ])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", default="1 day ago")
    parser.add_argument("--base-ref")
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_MAP)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--markdown-out", type=Path)
    parser.add_argument("--fail-on-drift", action="store_true")
    args = parser.parse_args(argv)
    try:
        files = changed_files(REPO_ROOT, args.since, args.base_ref)
        report = analyze(
            REPO_ROOT,
            load_json(args.map_path),
            load_json(args.manifest),
            files,
            dt.datetime.now(dt.timezone.utc),
        )
        payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        markdown = render_markdown(report)
        if args.json_out:
            args.json_out.parent.mkdir(parents=True, exist_ok=True)
            args.json_out.write_text(payload, encoding="utf-8")
        if args.markdown_out:
            args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
            args.markdown_out.write_text(markdown, encoding="utf-8")
        print(markdown)
        return 1 if args.fail_on_drift and report["status"] == "drift" else 0
    except MaintenanceError as exc:
        print(f"教程巡检失败: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
