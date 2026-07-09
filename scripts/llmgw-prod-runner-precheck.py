#!/usr/bin/env python3
"""Fail fast when a production self-hosted runner is unavailable.

The production stage job must run on the production host because fast.sh and
exec_dep.sh operate on local Docker/compose state. Without this precheck,
GitHub leaves the rollout job queued indefinitely when the runner label does
not exist or is offline.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any


def _json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)


def _parse_labels(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"runner labels JSON is invalid: {exc}") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("runner labels JSON must be a string array")
    labels = [item.strip() for item in value if item.strip()]
    if not labels:
        raise ValueError("runner labels JSON must contain at least one label")
    return labels


def _fetch_repo_runners(repo: str, token: str) -> list[dict[str, Any]]:
    url = f"https://api.github.com/repos/{repo}/actions/runners?per_page=100"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "prd-agent-llmgw-prod-runner-precheck",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    runners = payload.get("runners", [])
    return runners if isinstance(runners, list) else []


def _labels_of(runner: dict[str, Any]) -> set[str]:
    labels = runner.get("labels", [])
    result: set[str] = set()
    if isinstance(labels, list):
        for item in labels:
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip().lower()
            else:
                name = str(item or "").strip().lower()
            if name:
                result.add(name)
    return result


def _write_report(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(_json_dumps(report))


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway production runner precheck")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--labels-json", required=True)
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()

    generated_at = datetime.now(timezone.utc).isoformat()
    checks: list[dict[str, Any]] = []

    try:
        labels = _parse_labels(args.labels_json)
    except ValueError as exc:
        report = {
            "generatedAt": generated_at,
            "verdict": "fail",
            "checks": [{"name": "runner_labels_json", "ok": False, "detail": str(exc)}],
        }
        _write_report(args.json_out, report)
        print(_json_dumps(report))
        return 1

    normalized_labels = {label.lower() for label in labels}
    checks.append({"name": "runner_labels_json", "ok": True, "detail": labels})

    if "self-hosted" not in normalized_labels:
        checks.append(
            {
                "name": "self_hosted_runner_required",
                "ok": True,
                "detail": "runner labels do not request self-hosted; availability check skipped",
            }
        )
        report = {
            "generatedAt": generated_at,
            "verdict": "pass",
            "labels": labels,
            "checks": checks,
        }
        _write_report(args.json_out, report)
        print(_json_dumps(report))
        return 0

    repo = args.repo.strip()
    if not repo:
        checks.append({"name": "github_repository", "ok": False, "detail": "missing repository"})
        report = {"generatedAt": generated_at, "verdict": "fail", "labels": labels, "checks": checks}
        _write_report(args.json_out, report)
        print(_json_dumps(report))
        return 1
    checks.append({"name": "github_repository", "ok": True, "detail": repo})

    token = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    if not token:
        checks.append({"name": "github_token", "ok": False, "detail": "missing GITHUB_TOKEN"})
        report = {"generatedAt": generated_at, "verdict": "fail", "labels": labels, "checks": checks}
        _write_report(args.json_out, report)
        print(_json_dumps(report))
        return 1

    try:
        runners = _fetch_repo_runners(repo, token)
    except urllib.error.HTTPError as exc:
        checks.append({"name": "runner_api", "ok": False, "detail": f"GitHub runner API returned HTTP {exc.code}"})
        report = {"generatedAt": generated_at, "verdict": "fail", "labels": labels, "checks": checks}
        _write_report(args.json_out, report)
        print(_json_dumps(report))
        return 1
    except (urllib.error.URLError, TimeoutError) as exc:
        checks.append({"name": "runner_api", "ok": False, "detail": str(exc)})
        report = {"generatedAt": generated_at, "verdict": "fail", "labels": labels, "checks": checks}
        _write_report(args.json_out, report)
        print(_json_dumps(report))
        return 1

    checks.append({"name": "runner_api", "ok": True, "detail": f"runners={len(runners)}"})
    matching = []
    for runner in runners:
        runner_labels = _labels_of(runner)
        if normalized_labels.issubset(runner_labels):
            matching.append(
                {
                    "name": runner.get("name"),
                    "status": runner.get("status"),
                    "busy": runner.get("busy"),
                    "labels": sorted(runner_labels),
                }
            )

    online = [runner for runner in matching if str(runner.get("status") or "").lower() == "online"]
    if online:
        checks.append({"name": "matching_online_runner", "ok": True, "detail": online})
        verdict = "pass"
    else:
        checks.append(
            {
                "name": "matching_online_runner",
                "ok": False,
                "detail": {
                    "requiredLabels": labels,
                    "matchingRunners": matching,
                    "remediation": "Start or register a production runner with all requested labels before execute=true.",
                },
            }
        )
        verdict = "fail"

    report = {
        "generatedAt": generated_at,
        "verdict": verdict,
        "labels": labels,
        "checks": checks,
    }
    _write_report(args.json_out, report)
    print(_json_dumps(report))
    return 0 if verdict == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
