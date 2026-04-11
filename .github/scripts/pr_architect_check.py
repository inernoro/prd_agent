#!/usr/bin/env python3
"""PR architect gate checker (V1, L1 deterministic only)."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import yaml
except Exception as exc:  # pragma: no cover
    print(f"::error::Failed to import PyYAML: {exc}")
    sys.exit(2)


ROOT = Path(__file__).resolve().parents[2]
RULES_PATH = ROOT / ".github/pr-architect/review-rules.yml"
SOURCES_PATH = ROOT / ".github/pr-architect/design-sources.yml"
REPO_BINDINGS_PATH = ROOT / ".github/pr-architect/repo-bindings.yml"


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

    def to_payload(
        self,
        repository: str,
        pr_number: int | None,
        head_sha: str,
        metadata: dict[str, Any] | None = None,
        metadata_quality: dict[str, Any] | None = None,
        binding: dict[str, Any] | None = None,
        recommended_decision: str = "Approve",
        focus_questions: list[str] | None = None,
        final_decision: str | None = None,
        guardrails_complete: bool | None = None,
    ) -> dict[str, Any]:
        return {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "repository": repository,
            "pr_number": pr_number,
            "head_sha": head_sha,
            "metadata": metadata or {},
            "metadata_quality": metadata_quality or {},
            "template_completeness_rate": (metadata_quality or {}).get("completeness_rate", 0.0),
            "binding": binding or {},
            "recommended_decision": recommended_decision,
            "architect_focus_questions": focus_questions or [],
            "final_decision": final_decision,
            "guardrails_complete": guardrails_complete,
            "errors": self.errors,
            "advisories": self.advisories,
            "infos": self.infos,
            "status": "fail" if self.errors else "pass",
        }


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


def is_bootstrap_design_source(source: dict[str, Any]) -> bool:
    source_id = str(source.get("id", "")).strip().lower()
    location = str(source.get("location", "")).strip().lower()
    checksum = str(source.get("checksum", "")).strip().lower()
    description = str(source.get("description", "")).strip().lower()
    return (
        source_id.startswith("bootstrap")
        or location.endswith(".github/pr-architect/top-design.bootstrap.md")
        or "bootstrap-replace" in checksum
        or "占位源" in description
        or "placeholder" in description
    )


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


def build_metadata_quality(metadata: dict[str, Any], required_keys: list[str]) -> dict[str, Any]:
    missing: list[str] = []
    for key in required_keys:
        if key not in metadata:
            missing.append(key)
            continue
        if is_blank(metadata.get(key)):
            missing.append(key)
    total = len(required_keys)
    present = max(0, total - len(missing))
    rate = (present / total) if total > 0 else 1.0
    return {
        "required_keys_total": total,
        "required_keys_present": present,
        "required_keys_missing": missing,
        "completeness_rate": round(rate, 4),
    }


def get_focus_questions(rules: dict[str, Any]) -> list[str]:
    focus_cfg = rules.get("architect_focus_questions")
    if not isinstance(focus_cfg, dict):
        return []
    max_items = focus_cfg.get("max_items")
    if not isinstance(max_items, int) or max_items <= 0:
        max_items = 3
    raw = focus_cfg.get("focus")
    if not isinstance(raw, list):
        return []
    items = [str(i).strip() for i in raw if str(i).strip()]
    return items[:max_items]


def infer_repository_name(event: dict[str, Any]) -> str:
    repo_obj = event.get("repository") or {}
    if isinstance(repo_obj, dict):
        full_name = str(repo_obj.get("full_name") or "").strip()
        if full_name:
            return full_name

    pr_obj = event.get("pull_request") or {}
    if isinstance(pr_obj, dict):
        html_url = str(pr_obj.get("html_url") or "").strip()
        if html_url:
            parsed = urlparse(html_url)
            path_parts = [p for p in parsed.path.split("/") if p]
            if len(path_parts) >= 2:
                return f"{path_parts[0]}/{path_parts[1]}"

    env_repo = str(os.getenv("GITHUB_REPOSITORY", "")).strip()
    if env_repo:
        return env_repo
    return ""


def resolve_repo_binding(
    event: dict[str, Any],
    bindings: dict[str, Any],
    result: GateResult,
) -> tuple[str, dict[str, Any]]:
    repository = infer_repository_name(event)
    if not repository:
        result.error("cannot infer repository full name from event payload")
        return "", {}

    defaults = bindings.get("defaults")
    if not isinstance(defaults, dict):
        result.error("repo-bindings.yml missing defaults object")
        return repository, {}

    repos = bindings.get("repositories")
    if not isinstance(repos, list) or len(repos) == 0:
        result.error("repo-bindings.yml repositories must be a non-empty list")
        return repository, {}

    default_enabled = bool(defaults.get("enabled", False))
    default_checks = defaults.get("required_checks")
    if not isinstance(default_checks, list):
        default_checks = []

    selected: dict[str, Any] | None = None
    for item in repos:
        if not isinstance(item, dict):
            continue
        repo_name = str(item.get("repo", "")).strip()
        if repo_name and repo_name.lower() == repository.lower():
            selected = dict(item)
            break

    if selected is None:
        result.error(f"repository not found in repo-bindings.yml: {repository}")
        return repository, {}

    if "enabled" not in selected:
        selected["enabled"] = default_enabled
    if "required_checks" not in selected or not isinstance(selected.get("required_checks"), list):
        selected["required_checks"] = list(default_checks)

    enabled = bool(selected.get("enabled", False))
    if not enabled:
        result.error(f"repository binding exists but disabled: {repository}")
        return repository, {}

    required_checks = selected.get("required_checks") or []
    if "PR审查棱镜 L1 Gate" not in required_checks:
        result.error(
            "repository binding missing required check 'PR审查棱镜 L1 Gate'; "
            "branch protection would be inconsistent."
        )
        return repository, {}

    for key in ("design_source_id", "design_source_version"):
        if is_blank(selected.get(key)):
            result.error(f"repository binding missing required key: {key}")

    if not result.errors:
        result.info(
            f"resolved repository binding for {repository}: "
            f"{selected.get('design_source_id')}@{selected.get('design_source_version')}"
        )
    return repository, selected if not result.errors else {}


def enforce_binding_alignment(
    metadata: dict[str, Any],
    binding: dict[str, Any],
    result: GateResult,
) -> None:
    if not binding:
        return
    bind_source = str(binding.get("design_source_id", "")).strip()
    bind_version = str(binding.get("design_source_version", "")).strip()
    pr_source = str(metadata.get("design_source_id", "")).strip()
    pr_version = str(metadata.get("design_source_version", "")).strip()

    if bind_source and pr_source and bind_source != pr_source:
        result.error(
            "design source mismatch with repository binding: "
            f"expected {bind_source}, got {pr_source}"
        )
    if bind_version and pr_version and bind_version != pr_version:
        result.error(
            "design source version mismatch with repository binding: "
            f"expected {bind_version}, got {pr_version}"
        )


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
    if is_bootstrap_design_source(source):
        result.error(
            "active design source is still bootstrap placeholder; "
            "initialize real top-design baseline first (run scripts/init-pr-prism-basis.sh "
            "or replace design-sources.yml with real manifests)."
        )
        return

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


def parse_final_decision(pr_body: str) -> str | None:
    match = re.search(r"最终裁决[:：]\s*(.+)", pr_body)
    if not match:
        return None
    tail = match.group(1).strip()
    # 未填写时模板通常带 "/" 多选项，判定为未声明
    if "/" in tail:
        return None
    # 去掉 markdown backticks 和项目符号残留
    cleaned = tail.replace("`", "").strip().lstrip("-").strip()
    allowed = {
        "Approve",
        "Approve with Guardrails",
        "Request Changes",
        "Block",
    }
    return cleaned if cleaned in allowed else None


def check_guardrails_requirements(
    final_decision: str | None,
    pr_body: str,
    yaml_blocks: list[dict[str, Any]],
    result: GateResult,
) -> bool | None:
    if final_decision != "Approve with Guardrails":
        return None

    block = find_yaml_block_with_key(yaml_blocks, "guardrails")
    if block and isinstance(block.get("guardrails"), dict):
        guardrails = block["guardrails"]
        required = ["plan", "rollback_trigger", "owner_on_call"]
        missing = [k for k in required if is_blank(guardrails.get(k))]
        if missing:
            result.advisory(
                "final decision is Approve with Guardrails but guardrails fields are incomplete: "
                + ", ".join(missing)
            )
            return False
        return True

    line_match = re.search(r"护栏条件（开关/灰度/监控/回滚触发）[:：]\s*(.+)", pr_body)
    if line_match:
        text = line_match.group(1).strip()
        if text and text.lower() != "n/a":
            return True

    result.advisory(
        "final decision is Approve with Guardrails but guardrails block/field is missing"
    )
    return False


def derive_recommended_decision(
    result: GateResult,
    final_decision: str | None,
    guardrails_complete: bool | None,
) -> str:
    if result.errors:
        return "Block"
    if final_decision == "Approve with Guardrails":
        if guardrails_complete is True and not result.advisories:
            return "Approve with Guardrails"
        return "Request Changes"
    if result.advisories:
        return "Request Changes"
    return "Approve"


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
        "# PR审查棱镜 Check (V1 / L1)",
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


def write_json_result(payload: dict[str, Any]) -> None:
    output_path = os.getenv("PR_ARCHITECT_RESULT_PATH")
    if output_path:
        path = Path(output_path)
    else:
        path = ROOT / "artifacts/pr-architect/review_run.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[INFO] result JSON written: {path}")


def main() -> int:
    result = GateResult()

    rules = load_yaml_file(RULES_PATH, result, "review-rules")
    registry = load_yaml_file(SOURCES_PATH, result, "design-sources")
    repo_bindings = load_yaml_file(REPO_BINDINGS_PATH, result, "repo-bindings")
    if result.errors:
        write_json_result(
            result.to_payload(
                repository=str(os.getenv("GITHUB_REPOSITORY", "")).strip(),
                pr_number=None,
                head_sha="",
            )
        )
        write_summary(result)
        return 1

    event_path = os.getenv("GITHUB_EVENT_PATH")
    if not event_path:
        result.error("GITHUB_EVENT_PATH is missing")
        write_json_result(
            result.to_payload(
                repository=str(os.getenv("GITHUB_REPOSITORY", "")).strip(),
                pr_number=None,
                head_sha="",
            )
        )
        write_summary(result)
        return 1

    try:
        with open(event_path, "r", encoding="utf-8") as f:
            event = json.load(f)
    except Exception as exc:
        result.error(f"failed to load GitHub event payload: {exc}")
        write_json_result(
            result.to_payload(
                repository=str(os.getenv("GITHUB_REPOSITORY", "")).strip(),
                pr_number=None,
                head_sha="",
            )
        )
        write_summary(result)
        return 1

    repository, binding = resolve_repo_binding(event, repo_bindings, result)
    pr = event.get("pull_request") or {}
    pr_body = str(pr.get("body") or "")
    pr_number = pr.get("number")
    head_obj = pr.get("head") or {}
    head_sha = str(head_obj.get("sha") or "")

    if not pr_body.strip():
        result.error("PR body is empty; cannot parse metadata")
        write_json_result(result.to_payload(repository, pr_number, head_sha))
        write_summary(result)
        return 1

    yaml_blocks = extract_yaml_blocks(pr_body, result)
    metadata = extract_metadata(pr_body, yaml_blocks)
    if not metadata:
        result.error("failed to parse metadata YAML from PR body section 1")
        write_json_result(result.to_payload(repository, pr_number, head_sha))
        write_summary(result)
        return 1

    required_keys = get_required_keys(rules)
    metadata = hydrate_metadata_from_blocks(metadata, yaml_blocks, required_keys)
    metadata_quality = build_metadata_quality(metadata, required_keys)
    validate_required_metadata(metadata, required_keys, result)
    enforce_binding_alignment(metadata, binding, result)
    check_design_source_and_anchors(metadata, registry, result)
    check_out_of_slice_adr(metadata, pr_body, result)

    # Advisory-only checks for V1.
    run_advisory_checks(metadata, yaml_blocks, result)
    final_decision = parse_final_decision(pr_body)
    guardrails_complete = check_guardrails_requirements(
        final_decision,
        pr_body,
        yaml_blocks,
        result,
    )
    recommended_decision = derive_recommended_decision(
        result,
        final_decision,
        guardrails_complete,
    )
    focus_questions = get_focus_questions(rules)

    write_json_result(
        result.to_payload(
            repository,
            pr_number,
            head_sha,
            metadata=metadata,
            metadata_quality=metadata_quality,
            binding=binding,
            recommended_decision=recommended_decision,
            focus_questions=focus_questions,
            final_decision=final_decision,
            guardrails_complete=guardrails_complete,
        )
    )
    write_summary(result)
    if result.errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
