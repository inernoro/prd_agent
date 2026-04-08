#!/usr/bin/env python3
"""PR architect gate checker (V1, L1 deterministic only)."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception as exc:  # pragma: no cover
    print(f"::error::Failed to import PyYAML: {exc}")
    sys.exit(2)


ROOT = Path(__file__).resolve().parents[2]
RULES_PATH = ROOT / ".github/pr-architect/review-rules.yml"
SOURCES_PATH = ROOT / ".github/pr-architect/design-sources.yml"


class GateResult:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.advisories: list[str] = []
        self.infos: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)
        print(f"::error title=pr-architect-gate::{message}")

    def advisory(self, message: str) -> None:
        self.advisories.append(message)
        print(f"::warning title=pr-architect-gate::{message}")

    def info(self, message: str) -> None:
        self.infos.append(message)
        print(f"[INFO] {message}")


def load_yaml_file(path: Path, result: GateResult, label: str) -> dict[str, Any]:
    if not path.exists():
        result.error(f"{label} missing: {path}")
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            result.error(f"{label} must be a YAML object: {path}")
            return {}
        return data
    except Exception as exc:
        result.error(f"{label} invalid YAML ({path}): {exc}")
        return {}


def extract_yaml_blocks(pr_body: str, result: GateResult) -> list[dict[str, Any]]:
    blocks = re.findall(r"```yaml\s*(.*?)```", pr_body, flags=re.S)
    parsed: list[dict[str, Any]] = []
    for raw in blocks:
        try:
            obj = yaml.safe_load(raw) or {}
        except Exception as exc:
            result.error(f"Invalid YAML block in PR body: {exc}")
            continue
        if isinstance(obj, dict):
            parsed.append(obj)
    return parsed


def extract_metadata(pr_body: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    section_match = re.search(
        r"##\s*1\)\s*基础元数据（必填）.*?```yaml\s*(.*?)```",
        pr_body,
        flags=re.S,
    )
    if section_match:
        try:
            obj = yaml.safe_load(section_match.group(1)) or {}
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass

    # Fallback: use first YAML block.
    return blocks[0] if blocks else {}


def hydrate_metadata_from_blocks(
    metadata: dict[str, Any],
    blocks: list[dict[str, Any]],
    required_keys: list[str],
) -> dict[str, Any]:
    """Fill missing required metadata keys from other YAML blocks in PR body.

    This keeps section-1 metadata as the source of truth while supporting
    template sections that place required objects (for example tests_evidence)
    in later YAML blocks.
    """
    merged = dict(metadata)
    for key in required_keys:
        if key in merged and not is_blank(merged.get(key)):
            continue
        for block in blocks:
            if isinstance(block, dict) and key in block:
                merged[key] = block[key]
                break
    return merged


def extract_adr_link(pr_body: str) -> str:
    match = re.search(r"ADR 链接（如无则填 N/A）[:：]\s*(.+)", pr_body)
    return match.group(1).strip() if match else ""


def normalize_anchor_ids(payload: Any) -> set[str]:
    ids: set[str] = set()
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, str) and item.strip():
                ids.add(item.strip())
            elif isinstance(item, dict):
                item_id = str(item.get("id", "")).strip()
                if item_id:
                    ids.add(item_id)
    elif isinstance(payload, dict):
        # Support object forms if needed.
        for key in ("anchors", "items"):
            if key in payload:
                return normalize_anchor_ids(payload[key])
    return ids


def load_anchor_ids_from_manifest(
    manifest_ref: str,
    result: GateResult,
) -> set[str]:
    if manifest_ref.startswith("http://") or manifest_ref.startswith("https://"):
        result.error(
            "anchors manifest uses URL source; V1 checker only supports repo-file manifests."
        )
        return set()
    if manifest_ref.startswith("artifact://"):
        result.error(
            "anchors manifest uses artifact source; V1 checker only supports repo-file manifests."
        )
        return set()

    manifest_path = ROOT / manifest_ref
    if not manifest_path.exists():
        result.error(f"anchors manifest not found: {manifest_ref}")
        return set()

    try:
        with manifest_path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:
        result.error(f"anchors manifest invalid YAML ({manifest_ref}): {exc}")
        return set()

    if isinstance(data, list):
        return normalize_anchor_ids(data)

    if isinstance(data, dict):
        return normalize_anchor_ids(data.get("anchors"))

    result.error(f"anchors manifest format unsupported: {manifest_ref}")
    return set()


def is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) == 0
    return False


def get_required_keys(rules: dict[str, Any]) -> list[str]:
    required = []
    for item in rules.get("required_pr_metadata", []):
        if isinstance(item, dict) and item.get("required") is True:
            key = str(item.get("key", "")).strip()
            if key:
                required.append(key)
    return required


def validate_required_metadata(
    metadata: dict[str, Any],
    required_keys: list[str],
    result: GateResult,
) -> None:
    bool_keys = {
        "out_of_slice_changes",
        "contract_change_declared",
        "compatibility_plan_attached",
        "critical_path_changed",
        "skills_traceability_attached",
    }
    non_empty_list_keys = {"anchor_refs", "skills_used"}
    non_empty_dict_keys = {"tests_evidence"}

    for key in required_keys:
        if key not in metadata:
            result.error(f"missing required metadata key: {key}")
            continue

        value = metadata.get(key)
        if key in bool_keys:
            if not isinstance(value, bool):
                result.error(f"metadata key must be boolean: {key}")
            continue

        if key in non_empty_list_keys:
            if not isinstance(value, list) or len(value) == 0:
                result.error(f"metadata key must be a non-empty list: {key}")
            continue

        if key in non_empty_dict_keys:
            if not isinstance(value, dict) or len(value) == 0:
                result.error(f"metadata key must be a non-empty object: {key}")
                continue
            if key == "tests_evidence":
                if not any(str(v).strip() for v in value.values() if v is not None):
                    result.error("tests_evidence must include at least one non-empty evidence")
            continue

        if is_blank(value):
            result.error(f"metadata key cannot be empty: {key}")


def find_yaml_block_with_key(
    blocks: list[dict[str, Any]],
    key: str,
) -> dict[str, Any] | None:
    for block in blocks:
        if key in block:
            return block
    return None


def check_design_source_and_anchors(
    metadata: dict[str, Any],
    registry: dict[str, Any],
    result: GateResult,
) -> None:
    defaults = registry.get("defaults")
    if not isinstance(defaults, dict):
        result.error("design-sources.yml missing defaults object")
        return

    active_id = str(defaults.get("active_source_id", "")).strip()
    active_version = str(defaults.get("active_version", "")).strip()
    enforce_manifests = bool(defaults.get("enforce_manifests", False))

    sources = registry.get("sources")
    if not isinstance(sources, list) or len(sources) == 0:
        result.error("design-sources.yml sources must be a non-empty list")
        return

    if not active_id or not active_version:
        result.error("design-sources.yml defaults.active_source_id and active_version are required")
        return

    source_map: dict[str, dict[str, Any]] = {}
    for source in sources:
        if not isinstance(source, dict):
            continue
        sid = str(source.get("id", "")).strip()
        if sid:
            source_map[sid] = source

    pr_source_id = str(metadata.get("design_source_id", "")).strip()
    pr_source_version = str(metadata.get("design_source_version", "")).strip()
    if pr_source_id not in source_map:
        result.error(
            f"design_source_id not registered in design-sources.yml: {pr_source_id}"
        )
        return

    if pr_source_id != active_id or pr_source_version != active_version:
        result.error(
            "design source mismatch: PR must align with active_source_id/active_version."
        )
        return

    source = source_map[pr_source_id]
    source_version = str(source.get("version", "")).strip()
    if source_version != pr_source_version:
        result.error(
            "design source mismatch: PR design_source_version differs from source version."
        )
        return

    if not enforce_manifests:
        result.info("enforce_manifests=false, skipping anchor manifest validation")
        return

    manifests = source.get("manifests")
    if not isinstance(manifests, dict):
        result.error("design source manifests are required when enforce_manifests=true")
        return

    anchors_ref = str(manifests.get("anchors", "")).strip()
    if not anchors_ref:
        result.error("anchors manifest path is required when enforce_manifests=true")
        return

    anchor_ids = load_anchor_ids_from_manifest(anchors_ref, result)
    if not anchor_ids:
        return

    pr_anchors = metadata.get("anchor_refs", [])
    missing = [anchor for anchor in pr_anchors if anchor not in anchor_ids]
    if missing:
        result.error(
            "anchor_refs not found in active design-source anchors manifest: "
            + ", ".join(missing)
        )


def check_out_of_slice_adr(metadata: dict[str, Any], pr_body: str, result: GateResult) -> None:
    if metadata.get("out_of_slice_changes") is not True:
        return
    adr_link = extract_adr_link(pr_body)
    if not adr_link or adr_link.lower() == "n/a":
        result.error("out_of_slice_changes=true requires a non-N/A ADR link")


def run_advisory_checks(
    metadata: dict[str, Any],
    yaml_blocks: list[dict[str, Any]],
    result: GateResult,
) -> None:
    skills_used = metadata.get("skills_used", [])
    skills_traceability_attached = metadata.get("skills_traceability_attached")
    if isinstance(skills_used, list) and len(skills_used) > 0:
        if skills_traceability_attached is False:
            result.advisory("skills_used is non-empty but skills_traceability_attached=false")
        trace_block = find_yaml_block_with_key(yaml_blocks, "skills_traceability")
        if skills_traceability_attached is True:
            if not trace_block:
                result.advisory(
                    "skills_traceability_attached=true but skills_traceability block is missing"
                )
            else:
                payload = trace_block.get("skills_traceability")
                if not isinstance(payload, list) or len(payload) == 0:
                    result.advisory("skills_traceability must be a non-empty list")

    contract_changed = metadata.get("contract_change_declared") is True
    compat_attached = metadata.get("compatibility_plan_attached")
    if contract_changed and compat_attached is not True:
        result.advisory(
            "contract_change_declared=true but compatibility_plan_attached is not true"
        )


def write_summary(result: GateResult) -> None:
    summary_path = os.getenv("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return

    lines = [
        "# PR Architect Check (V1 / L1)",
        "",
        f"- errors: {len(result.errors)}",
        f"- advisories: {len(result.advisories)}",
        "",
    ]

    if result.errors:
        lines.append("## Blockers")
        for item in result.errors:
            lines.append(f"- {item}")
        lines.append("")

    if result.advisories:
        lines.append("## Advisories")
        for item in result.advisories:
            lines.append(f"- {item}")
        lines.append("")

    if not result.errors:
        lines.append("Result: pass")
    else:
        lines.append("Result: fail")

    with open(summary_path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main() -> int:
    result = GateResult()

    rules = load_yaml_file(RULES_PATH, result, "review-rules")
    registry = load_yaml_file(SOURCES_PATH, result, "design-sources")
    if result.errors:
        write_summary(result)
        return 1

    event_path = os.getenv("GITHUB_EVENT_PATH")
    if not event_path:
        result.error("GITHUB_EVENT_PATH is missing")
        write_summary(result)
        return 1

    try:
        with open(event_path, "r", encoding="utf-8") as f:
            event = json.load(f)
    except Exception as exc:
        result.error(f"failed to load GitHub event payload: {exc}")
        write_summary(result)
        return 1

    pr = event.get("pull_request") or {}
    pr_body = str(pr.get("body") or "")
    if not pr_body.strip():
        result.error("PR body is empty; cannot parse metadata")
        write_summary(result)
        return 1

    yaml_blocks = extract_yaml_blocks(pr_body, result)
    metadata = extract_metadata(pr_body, yaml_blocks)
    if not metadata:
        result.error("failed to parse metadata YAML from PR body section 1")
        write_summary(result)
        return 1

    required_keys = get_required_keys(rules)
    metadata = hydrate_metadata_from_blocks(metadata, yaml_blocks, required_keys)
    validate_required_metadata(metadata, required_keys, result)
    check_design_source_and_anchors(metadata, registry, result)
    check_out_of_slice_adr(metadata, pr_body, result)

    # Advisory-only checks for V1.
    run_advisory_checks(metadata, yaml_blocks, result)

    write_summary(result)
    if result.errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
