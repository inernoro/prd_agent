#!/usr/bin/env python3
"""Aggregate PR architect review_run artifacts into lightweight metrics."""

from __future__ import annotations

import json
import datetime as dt
import os
import statistics
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def iter_review_runs(input_dir: Path) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    if not input_dir.exists():
        return runs
    for p in input_dir.rglob("review_run.json"):
        try:
            runs.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    return runs


def github_api_request(token: str, url: str) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pr-architect-metrics",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"GitHub API HTTPError {exc.code}: {body[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub API URLError: {exc}") from exc


def collect_open_pr_timing(token: str, repo: str) -> tuple[float, int]:
    """Return average hours from PR creation to now for open PRs."""
    url = f"https://api.github.com/repos/{repo}/pulls?state=open&per_page=100"
    data = github_api_request(token, url)
    if not isinstance(data, list):
        return 0.0, 0
    hours: list[float] = []
    now = dt.datetime.now(dt.timezone.utc)
    for item in data:
        if not isinstance(item, dict):
            continue
        created_at = str(item.get("created_at") or "").strip()
        if not created_at:
            continue
        try:
            created = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except Exception:
            continue
        diff_hours = max(0.0, (now - created).total_seconds() / 3600.0)
        hours.append(diff_hours)
    if not hours:
        return 0.0, 0
    return statistics.fmean(hours), len(hours)


def safe_ratio(n: int, d: int) -> float:
    if d <= 0:
        return 0.0
    return n / d


def main() -> int:
    input_dir = Path(os.getenv("PR_ARCHITECT_METRICS_INPUT", "artifacts/pr-architect"))
    out_path = Path(os.getenv("PR_ARCHITECT_METRICS_OUTPUT", "metrics/pr-architect-metrics.jsonl"))

    runs = iter_review_runs(input_dir)
    total = len(runs)
    if total == 0:
        payload = {
            "total_runs": 0,
            "pass_count": 0,
            "fail_count": 0,
            "template_completeness_rate": 0.0,
            "avg_advisories": 0.0,
            "open_pr_avg_hours": 0.0,
            "open_pr_count": 0,
            "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"[INFO] metrics written: {out_path}")
        return 0

    pass_count = sum(1 for r in runs if str(r.get("status")) == "pass")
    fail_count = total - pass_count
    completeness = [float(r.get("template_completeness_rate", 0.0)) for r in runs]
    advisories_count = [len(r.get("advisories", []) or []) for r in runs]

    token = os.getenv("GITHUB_TOKEN", "").strip()
    repo = os.getenv("GITHUB_REPOSITORY", "").strip()
    open_pr_avg_hours = 0.0
    open_pr_count = 0
    if token and repo:
        try:
            open_pr_avg_hours, open_pr_count = collect_open_pr_timing(token, repo)
        except Exception as exc:
            print(f"[WARN] failed to collect PR timing metrics: {exc}")

    payload = {
        "total_runs": total,
        "pass_count": pass_count,
        "fail_count": fail_count,
        "template_completeness_rate": round(statistics.fmean(completeness), 4),
        "avg_advisories": round(statistics.fmean(advisories_count), 4),
        "open_pr_avg_hours": round(open_pr_avg_hours, 4),
        "open_pr_count": open_pr_count,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "pass_ratio": round(safe_ratio(pass_count, total), 4),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[INFO] metrics written: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
