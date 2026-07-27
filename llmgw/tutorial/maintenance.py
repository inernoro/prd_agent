#!/usr/bin/env python3
"""检查 LLMGW 页面、教程步骤与截图证据的双向关系，不自动改教程。"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
from pathlib import Path
import random
import re
import subprocess
import sys
from typing import Any


TUTORIAL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TUTORIAL_ROOT.parents[1]
DEFAULT_MAP = TUTORIAL_ROOT / "maintenance-map.json"
DEFAULT_MANIFEST = TUTORIAL_ROOT / "manifest.json"
DEFAULT_EVIDENCE_MAP = TUTORIAL_ROOT / "evidence-map.json"
PAGE_GLOB = "llmgw/web/src/pages/*.tsx"
STEP_MARKER = "<!-- tutorial-step: {step_id} -->"


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


def _git_output(repo_root: Path, command: list[str]) -> str:
    try:
        return subprocess.check_output(
            command,
            cwd=repo_root,
            text=True,
            stderr=subprocess.STDOUT,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "output", "")
        raise MaintenanceError(f"Git 命令失败: {detail or exc}") from exc


def changed_files(repo_root: Path, since: str, base_ref: str | None) -> list[str]:
    if base_ref:
        output = _git_output(repo_root, ["git", "diff", "--name-only", f"{base_ref}...HEAD"])
    else:
        output = _git_output(
            repo_root,
            ["git", "log", f"--since={since}", "--name-only", "--pretty=format:"],
        )
    return sorted({line.strip() for line in output.splitlines() if line.strip()})


def _git_head(repo_root: Path) -> str:
    return _git_output(repo_root, ["git", "rev-parse", "HEAD"])


def _tracked_files(repo_root: Path) -> list[str]:
    return [line for line in _git_output(repo_root, ["git", "ls-files"]).splitlines() if line]


def _is_ancestor(repo_root: Path, commit: str) -> bool:
    try:
        subprocess.check_call(
            ["git", "merge-base", "--is-ancestor", commit, "HEAD"],
            cwd=repo_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def _manifest_sources(repo_root: Path, manifest: dict[str, Any]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for node in manifest.get("nodes", []):
        if not isinstance(node, dict) or node.get("kind") != "document":
            continue
        source_id = node.get("sourceId")
        source_path = node.get("sourcePath")
        if isinstance(source_id, str) and isinstance(source_path, str):
            result[source_id] = repo_root / "llmgw" / "tutorial" / source_path
    return result


def _relative(repo_root: Path, path: Path) -> str:
    return str(path.relative_to(repo_root))


def _match_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def _evidence_by_source(evidence_map: dict[str, Any]) -> dict[str, set[str]]:
    chapters = evidence_map.get("chapters", {})
    if not isinstance(chapters, dict):
        raise MaintenanceError("evidence-map.chapters 必须是对象")
    result: dict[str, set[str]] = {}
    for key, values in chapters.items():
        if not isinstance(values, list):
            continue
        source_id = f"chapter-{key}" if str(key).isdigit() else str(key)
        result[source_id] = {value for value in values if isinstance(value, str)}
    return result


def _evidence_ids(evidence_map: dict[str, Any]) -> set[str]:
    return set().union(*_evidence_by_source(evidence_map).values())


def _finding(findings: list[dict[str, str]], severity: str, surface: str, message: str) -> None:
    item = {"severity": severity, "surface": surface, "message": message}
    if item not in findings:
        findings.append(item)


def _source_patterns(surface: dict[str, Any]) -> list[str]:
    page_path = surface.get("pagePath")
    patterns = [page_path] if isinstance(page_path, str) else []
    patterns.extend(
        pattern
        for pattern in surface.get("changeSources", [])
        if isinstance(pattern, str)
    )
    return patterns


def _build_reverse(
    surfaces: list[dict[str, Any]],
    sources: dict[str, Path],
    evidence_map: dict[str, Any],
) -> list[dict[str, Any]]:
    chapter_evidence = evidence_map.get("chapters", {})
    reverse: list[dict[str, Any]] = []
    for source_id, source_path in sources.items():
        linked_surfaces = []
        routes: list[str] = []
        step_ids: list[str] = []
        direct_evidence_ids: list[str] = []
        for surface in surfaces:
            if source_id not in surface.get("tutorialSourceIds", []):
                continue
            linked_surfaces.append(str(surface.get("id")))
            routes.extend(route for route in surface.get("routes", []) if isinstance(route, str))
            for link in surface.get("tutorialLinks", []):
                if isinstance(link, dict) and link.get("sourceId") == source_id:
                    step_ids.extend(step for step in link.get("stepIds", []) if isinstance(step, str))
                    direct_evidence_ids.extend(
                        evidence_id
                        for evidence_id in link.get("evidenceIds", [])
                        if isinstance(evidence_id, str)
                    )
        chapter_key = source_id.removeprefix("chapter-") if source_id.startswith("chapter-") else None
        registered = chapter_evidence.get(chapter_key, []) if chapter_key else []
        reverse.append({
            "sourceId": source_id,
            "sourcePath": str(source_path),
            "surfaceIds": sorted(set(linked_surfaces)),
            "routes": sorted(set(routes)),
            "stepIds": sorted(set(step_ids)),
            "evidenceIds": sorted(set(direct_evidence_ids or registered)),
        })
    return reverse


def _validate_graph(
    repo_root: Path,
    mapping: dict[str, Any],
    manifest: dict[str, Any],
    evidence_map: dict[str, Any],
    tracked_files: list[str],
) -> tuple[list[dict[str, str]], list[dict[str, Any]], dict[str, Path]]:
    if mapping.get("schemaVersion") != 2:
        raise MaintenanceError("maintenance-map.schemaVersion 必须为 2")
    if evidence_map.get("schemaVersion") != 2:
        raise MaintenanceError("evidence-map.schemaVersion 必须为 2")
    surfaces = mapping.get("surfaces")
    if not isinstance(surfaces, list):
        raise MaintenanceError("maintenance-map.surfaces 必须是数组")
    if not all(isinstance(surface, dict) for surface in surfaces):
        raise MaintenanceError("maintenance-map.surfaces 只能包含对象")

    sources = _manifest_sources(repo_root, manifest)
    evidence_by_source = _evidence_by_source(evidence_map)
    findings: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    seen_pages: set[str] = set()
    seen_routes: set[str] = set()
    mapped_pages: set[str] = set()

    for surface in surfaces:
        surface_id = surface.get("id")
        page_path = surface.get("pagePath")
        routes = surface.get("routes")
        source_ids = surface.get("tutorialSourceIds")
        if not isinstance(surface_id, str) or not surface_id:
            raise MaintenanceError("每个 surface 必须声明 id")
        if surface_id in seen_ids:
            raise MaintenanceError(f"surface id 重复: {surface_id}")
        seen_ids.add(surface_id)
        if not isinstance(page_path, str) or not page_path:
            raise MaintenanceError(f"{surface_id}: pagePath 不能为空")
        if page_path in seen_pages:
            raise MaintenanceError(f"页面映射重复: {page_path}")
        seen_pages.add(page_path)
        mapped_pages.add(page_path)
        if not (repo_root / page_path).is_file():
            _finding(findings, "P0", surface_id, f"映射页面不存在: {page_path}")
        if not isinstance(routes, list) or not routes:
            _finding(findings, "P1", surface_id, "没有声明可验收路由")
        else:
            for route in routes:
                if not isinstance(route, str) or not route.startswith("/"):
                    _finding(findings, "P1", surface_id, f"路由格式无效: {route}")
                elif route in seen_routes:
                    raise MaintenanceError(f"路由映射重复: {route}")
                else:
                    seen_routes.add(route)
        if not isinstance(source_ids, list) or not source_ids:
            raise MaintenanceError(f"{surface_id}: tutorialSourceIds 不能为空")
        for source_id in source_ids:
            if source_id not in sources or not sources[source_id].is_file():
                _finding(findings, "P0", surface_id, f"映射教程不存在: {source_id}")

        for pattern in surface.get("changeSources", []):
            if not isinstance(pattern, str):
                raise MaintenanceError(f"{surface_id}: changeSources 只能包含字符串")
            if not any(fnmatch.fnmatch(path, pattern) for path in tracked_files):
                _finding(findings, "P1", surface_id, f"变更来源没有匹配受控文件: {pattern}")

        for link in surface.get("tutorialLinks", []):
            if not isinstance(link, dict):
                raise MaintenanceError(f"{surface_id}: tutorialLinks 只能包含对象")
            source_id = link.get("sourceId")
            if source_id not in source_ids:
                _finding(findings, "P1", surface_id, f"步骤链接未进入教程清单: {source_id}")
                continue
            source_path = sources.get(str(source_id))
            source_text = source_path.read_text(encoding="utf-8") if source_path and source_path.is_file() else ""
            for step_id in link.get("stepIds", []):
                marker = STEP_MARKER.format(step_id=step_id)
                count = source_text.count(marker)
                if count != 1:
                    _finding(findings, "P1", surface_id, f"教程步骤标记必须恰好出现一次: {source_id}/{step_id}，当前 {count} 次")
            evidence_ids = link.get("evidenceIds", [])
            if mapping.get("policy", {}).get("requireEvidenceForLinkedChapter") and not evidence_ids:
                _finding(findings, "P1", surface_id, f"关联教程没有章节证据: {source_id}")
            registered = evidence_by_source.get(str(source_id), set())
            for evidence_id in evidence_ids:
                if evidence_id not in registered:
                    _finding(findings, "P1", surface_id, f"截图证据未注册到对应教程: {source_id}/{evidence_id}")

    app_path = repo_root / "llmgw/web/src/App.tsx"
    if app_path.is_file():
        app_routes = {
            route
            for route in re.findall(r'<Route\s+path="([^"]+)"', app_path.read_text(encoding="utf-8"))
            if route != "*"
        }
        for route in sorted(app_routes - seen_routes):
            _finding(findings, "P1", "routes", f"应用路由没有页面教程映射: {route}")
        for route in sorted(seen_routes - app_routes):
            _finding(findings, "P1", "routes", f"教程映射路由未在应用注册: {route}")

    for page in sorted(path for path in tracked_files if fnmatch.fnmatch(path, PAGE_GLOB)):
        if page not in mapped_pages:
            _finding(findings, "P1", page, "页面文件没有页面教程映射")

    reverse = _build_reverse(surfaces, sources, evidence_map)
    if mapping.get("policy", {}).get("requireTutorialReverseLink"):
        for item in reverse:
            if item["sourceId"] != "book-index" and not item["surfaceIds"]:
                _finding(findings, "P1", item["sourceId"], "教程无法反查任何页面或路由")

    verified_commit = evidence_map.get("verifiedAtCommit")
    if isinstance(verified_commit, str) and verified_commit and not _is_ancestor(repo_root, verified_commit):
        _finding(findings, "P1", "evidence", f"截图验收提交不是当前提交祖先: {verified_commit}")
    return findings, reverse, sources


def _random_audit(
    repo_root: Path,
    surfaces: list[dict[str, Any]],
    reverse: list[dict[str, Any]],
    sources: dict[str, Path],
    evidence_map: dict[str, Any],
    tracked_files: list[str],
    seed: str,
    sample_size: int,
) -> dict[str, Any]:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    rng = random.Random(int(digest, 16))
    sample = rng.sample(surfaces, min(sample_size, len(surfaces)))
    reverse_by_source = {item["sourceId"]: item for item in reverse}
    evidence_by_source = _evidence_by_source(evidence_map)
    checks: list[dict[str, Any]] = []

    def record(surface_id: str, name: str, passed: bool, detail: str) -> None:
        checks.append({"surface": surface_id, "check": name, "passed": passed, "detail": detail})

    for surface in sample:
        surface_id = str(surface["id"])
        page_path = str(surface["pagePath"])
        record(surface_id, "page-exists", (repo_root / page_path).is_file(), page_path)
        routes = surface.get("routes", [])
        record(surface_id, "routes", bool(routes) and all(str(route).startswith("/") for route in routes), ", ".join(routes))
        source_ids = surface.get("tutorialSourceIds", [])
        record(surface_id, "tutorial-sources", all(source_id in sources and sources[source_id].is_file() for source_id in source_ids), ", ".join(source_ids))
        reverse_ok = all(surface_id in reverse_by_source[source_id]["surfaceIds"] for source_id in source_ids if source_id in reverse_by_source)
        record(surface_id, "reverse-link", reverse_ok, "正反关系集合对称")
        patterns = _source_patterns(surface)
        pattern_ok = all(any(fnmatch.fnmatch(path, pattern) for path in tracked_files) for pattern in patterns)
        record(surface_id, "change-sources", pattern_ok, ", ".join(patterns))
        links = surface.get("tutorialLinks", [])
        marker_ok = True
        evidence_ok = True
        for link in links:
            source_id = str(link.get("sourceId"))
            source_path = sources.get(source_id)
            text = source_path.read_text(encoding="utf-8") if source_path and source_path.is_file() else ""
            marker_ok = marker_ok and all(text.count(STEP_MARKER.format(step_id=step_id)) == 1 for step_id in link.get("stepIds", []))
            evidence_ids = link.get("evidenceIds", [])
            evidence_ok = evidence_ok and bool(evidence_ids) and all(
                evidence_id in evidence_by_source.get(source_id, set()) for evidence_id in evidence_ids
            )
        record(surface_id, "step-markers", marker_ok, "步骤标记唯一")
        record(surface_id, "evidence", evidence_ok, "证据 ID 已注册")

    return {
        "status": "passed" if all(check["passed"] for check in checks) else "failed",
        "seed": seed,
        "sampleSize": len(sample),
        "surfaceIds": [str(surface["id"]) for surface in sample],
        "checks": checks,
    }


def analyze(
    repo_root: Path,
    mapping: dict[str, Any],
    manifest: dict[str, Any],
    files: list[str],
    now: dt.datetime,
    evidence_map: dict[str, Any] | None = None,
    *,
    audit_seed: str | None = None,
    sample_size: int | None = None,
    force_audit: bool = False,
) -> dict[str, Any]:
    evidence_map = evidence_map or load_json(DEFAULT_EVIDENCE_MAP)
    tracked_files = _tracked_files(repo_root)
    findings, reverse, sources = _validate_graph(repo_root, mapping, manifest, evidence_map, tracked_files)
    surfaces = mapping["surfaces"]
    global_sources = [item for item in mapping.get("globalChangeSources", []) if isinstance(item, dict)]
    source_path_to_id = {_relative(repo_root, path): source_id for source_id, path in sources.items()}
    changed_tutorial_ids = {source_path_to_id[path] for path in files if path in source_path_to_id}
    affected_ids: set[str] = set()
    impact_by_surface: dict[str, set[str]] = {}

    for path in files:
        global_impacts = {
            impact
            for item in global_sources
            if isinstance(item.get("glob"), str) and fnmatch.fnmatch(path, item["glob"])
            for impact in item.get("impact", [])
            if isinstance(impact, str)
        }
        if global_impacts:
            for surface in surfaces:
                surface_id = str(surface["id"])
                affected_ids.add(surface_id)
                impact_by_surface.setdefault(surface_id, set()).update(global_impacts)
        for surface in surfaces:
            surface_id = str(surface["id"])
            if _match_any(path, _source_patterns(surface)):
                affected_ids.add(surface_id)
                impact_by_surface.setdefault(surface_id, set()).update(["content", "screenshot"])
            if path in source_path_to_id and source_path_to_id[path] in surface.get("tutorialSourceIds", []):
                affected_ids.add(surface_id)
                impact_by_surface.setdefault(surface_id, set()).add("tutorial")

    changed_pages = sorted(path for path in files if fnmatch.fnmatch(path, PAGE_GLOB))
    mapped_pages = {str(surface["pagePath"]) for surface in surfaces}
    for page_path in changed_pages:
        if page_path not in mapped_pages:
            _finding(findings, "P1", page_path, "页面发生变化，但双链图谱没有对应教程")

    affected: list[dict[str, Any]] = []
    for surface in surfaces:
        surface_id = str(surface["id"])
        if surface_id not in affected_ids:
            continue
        source_ids = list(surface.get("tutorialSourceIds", []))
        changed_linked_sources = sorted(set(source_ids) & changed_tutorial_ids)
        link_status = "step-linked" if surface.get("tutorialLinks") else "coarse-review-required"
        affected.append({
            "surface": surface_id,
            "pagePath": surface["pagePath"],
            "routes": surface.get("routes", []),
            "tutorialSourceIds": source_ids,
            "changedTutorialSourceIds": changed_linked_sources,
            "impacts": sorted(impact_by_surface.get(surface_id, {"content"})),
            "linkStatus": link_status,
        })

        product_path = repo_root / str(surface["pagePath"])
        product_text = product_path.read_text(encoding="utf-8") if product_path.is_file() else ""
        tutorial_text = "\n".join(
            sources[source_id].read_text(encoding="utf-8")
            for source_id in source_ids
            if source_id in sources and sources[source_id].is_file()
        )
        for anchor in surface.get("anchors", []):
            name = str(anchor.get("name") or "未命名锚点")
            product_marker = str(anchor.get("product") or "")
            tutorial_marker = str(anchor.get("tutorial") or "")
            if not product_marker or product_marker not in product_text:
                _finding(findings, "P0", surface_id, f"稳定页面锚点已消失: {name}")
            elif not tutorial_marker or tutorial_marker not in tutorial_text:
                _finding(findings, "P1", surface_id, f"页面能力存在但教程缺少说明: {name}")

    metadata_inputs = {
        "llmgw/tutorial/maintenance-map.json",
        "llmgw/tutorial/evidence-map.json",
        "llmgw/tutorial/manifest.json",
    }
    metadata_changed = sorted(set(files) & metadata_inputs)
    relevant = bool(affected or changed_pages or metadata_changed)
    policy = mapping.get("policy", {})
    should_audit = force_audit or relevant
    seed = audit_seed or (_git_head(repo_root) if policy.get("randomAuditSeed") == "git-head" else now.date().isoformat())
    audit_size = sample_size or int(policy.get("randomAuditSampleSize", 5))
    random_audit = _random_audit(
        repo_root,
        surfaces,
        reverse,
        sources,
        evidence_map,
        tracked_files,
        seed,
        audit_size,
    ) if should_audit else {
        "status": "skipped",
        "seed": seed,
        "sampleSize": 0,
        "surfaceIds": [],
        "checks": [],
    }
    if random_audit["status"] == "failed":
        _finding(findings, "P1", "random-audit", "可复现随机抽检未全部通过")

    if findings:
        status = "drift"
    elif not relevant and policy.get("skipWhenNoRelevantChanges", True):
        status = "skipped"
    else:
        status = "review_required" if affected else "healthy"

    week = now.isocalendar()
    drafts = [] if status == "skipped" else [
        {
            "sourceId": f"{item['surface']}-update-{week.year}w{week.week:02d}",
            "tier": "advanced",
            "status": "draft",
            "tutorialSourceIds": item["tutorialSourceIds"],
            "summary": "产品能力发生变化，需按步骤与证据双链人工判断是否更新教程。",
        }
        for item in affected
    ]
    return {
        "schemaVersion": 2,
        "generatedAt": now.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": status,
        "skipReason": "no-relevant-changes" if status == "skipped" else None,
        "changedFiles": files,
        "changedPages": changed_pages,
        "affectedTutorials": affected,
        "pageToTutorial": [
            {
                "surface": surface["id"],
                "routes": surface.get("routes", []),
                "pagePath": surface["pagePath"],
                "changeSources": surface.get("changeSources", []),
                "tutorialSourceIds": surface.get("tutorialSourceIds", []),
                "stepIds": [step for link in surface.get("tutorialLinks", []) for step in link.get("stepIds", [])],
                "evidenceIds": [evidence for link in surface.get("tutorialLinks", []) for evidence in link.get("evidenceIds", [])],
            }
            for surface in surfaces
        ],
        "tutorialToPage": reverse,
        "randomAudit": random_audit,
        "findings": findings,
        "updateDrafts": drafts,
        "policy": "report-only-no-automatic-tutorial-update",
    }


def render_markdown(report: dict[str, Any]) -> str:
    labels = {
        "healthy": "正常",
        "review_required": "待复核",
        "drift": "有漂移",
        "skipped": "已跳过",
    }
    lines = [
        f"# [{labels[report['status']]}] LLMGW 教程双链巡检",
        "",
        f"生成时间：{report['generatedAt']}",
        "",
    ]
    if report["status"] == "skipped":
        lines.extend(["本次没有命中 LLMGW 页面、共享组件、接口、教程或证据源，未生成更新草稿。", ""])
    lines.extend(["## 页面到教程", "", "| 页面 | 路由 | 教程 | 步骤 | 证据 |", "|---|---|---|---|---|"])
    for item in report["pageToTutorial"]:
        lines.append(
            f"| {item['surface']} | {', '.join(item['routes'])} | {', '.join(item['tutorialSourceIds'])} | "
            f"{', '.join(item['stepIds']) or '粗粒度待迁移'} | {', '.join(item['evidenceIds']) or '按章节登记'} |"
        )
    lines.extend(["", "## 教程到页面", "", "| 教程 | 页面 | 路由 | 步骤 |", "|---|---|---|---|"])
    for item in report["tutorialToPage"]:
        if item["sourceId"] == "book-index":
            continue
        lines.append(
            f"| {item['sourceId']} | {', '.join(item['surfaceIds'])} | {', '.join(item['routes'])} | "
            f"{', '.join(item['stepIds']) or '粗粒度待迁移'} |"
        )
    audit = report["randomAudit"]
    lines.extend(["", "## 可复现随机抽检", "", f"种子：`{audit['seed']}`", f"状态：{audit['status']}"])
    if audit["surfaceIds"]:
        lines.append(f"抽样页面：{', '.join(audit['surfaceIds'])}")
    lines.extend(["", "## 受影响教程", ""])
    if report["affectedTutorials"]:
        for item in report["affectedTutorials"]:
            lines.append(
                f"- {item['surface']}: {', '.join(item['tutorialSourceIds'])}; "
                f"影响 {', '.join(item['impacts'])}; {item['linkStatus']}"
            )
    else:
        lines.append("- 无")
    lines.extend(["", "## 漂移告警", ""])
    if report["findings"]:
        for finding in report["findings"]:
            lines.append(f"- [{finding['severity']}] {finding['surface']}: {finding['message']}")
    else:
        lines.append("- P0/P1/P2 均为 0")
    lines.extend([
        "",
        "## 执行边界",
        "",
        "本巡检只维护关系图、输出漂移和更新草稿，不自动修改教程正文、截图或远端知识库。",
        "",
    ])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", default="1 day ago")
    parser.add_argument("--base-ref")
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_MAP)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--evidence-map", type=Path, default=DEFAULT_EVIDENCE_MAP)
    parser.add_argument("--seed")
    parser.add_argument("--sample-size", type=int)
    parser.add_argument("--force-audit", action="store_true")
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
            load_json(args.evidence_map),
            audit_seed=args.seed,
            sample_size=args.sample_size,
            force_audit=args.force_audit,
        )
        payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        markdown = render_markdown(report)
        for path, content in ((args.json_out, payload), (args.markdown_out, markdown)):
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
        print(markdown)
        return 1 if args.fail_on_drift and report["status"] == "drift" else 0
    except MaintenanceError as exc:
        print(f"教程巡检失败: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
