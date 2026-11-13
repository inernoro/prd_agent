#!/usr/bin/env python3
"""Check declared coverage and evidence structure; never assign a UX verdict."""
import argparse
import json
import math
from pathlib import Path

STATES = {
    "default", "tabs", "expanded", "empty", "few", "many", "loading", "error",
    "readonly", "desktop-light", "desktop-dark", "narrow-light", "narrow-dark",
}
PROVENANCE = {"deterministic-fixture", "preview-live", "integration-live"}
METRICS = ("first_data_y", "unnecessary_before_px", "task_scroll_px", "task_steps")


def validate(ledger, require_live=False, require_complete=False):
    errors = []
    counts = {"pages": 0, "cases": 0, "fixed": 0, "retained": 0,
              "blocked": 0, "not-applicable": 0, "failed_checks": 0}

    def issue(where, message):
        errors.append(f"{where}: {message}")

    def nonempty(value):
        return isinstance(value, str) and bool(value.strip())

    if not isinstance(ledger, dict) or ledger.get("schema_version") != 1:
        return ["ledger: expected object with schema_version 1"], counts
    target_revision = ledger.get("target_revision")
    if require_live and not nonempty(target_revision):
        issue("ledger", "target_revision required for same-version real-preview acceptance")
    scope, cases = ledger.get("scope"), ledger.get("cases")
    if not isinstance(scope, list) or not scope:
        issue("scope", "nonempty page inventory required")
        scope = []
    if not isinstance(cases, list):
        issue("cases", "array required")
        cases = []
    pages = {}
    for index, page in enumerate(scope):
        where = f"scope[{index}]"
        if not isinstance(page, dict):
            issue(where, "object required")
            continue
        for field in ("id", "route", "goal", "frequency", "core_action"):
            if not nonempty(page.get(field)):
                issue(where, f"nonempty {field} required")
        key = page.get("id")
        if not isinstance(key, str):
            continue
        if key in pages:
            issue(where, "duplicate page id")
        required = page.get("required_states")
        if not isinstance(required, list) or any(not nonempty(x) for x in required):
            issue(where, "required_states must be an array of nonempty strings")
            required = []
        if len(required) != len(set(required)):
            issue(where, "duplicate required state")
        missing = STATES - set(required)
        if missing:
            issue(where, "standard states absent: " + ", ".join(sorted(missing)))
        pages[key] = set(required)
    counts["pages"] = len(pages)
    observed = set()
    for index, case in enumerate(cases):
        where = f"cases[{index}]"
        if not isinstance(case, dict):
            issue(where, "object required")
            continue
        page, state = case.get("page"), case.get("state")
        if not isinstance(page, str) or page not in pages:
            issue(where, "page absent from declared scope")
            continue
        if not isinstance(state, str) or state not in pages[page]:
            issue(where, "state absent from page required_states")
            continue
        pair = (page, state)
        if pair in observed:
            issue(where, "duplicate page/state case")
        observed.add(pair)
        counts["cases"] += 1
        decision = case.get("decision")
        if decision not in ("fixed", "retained", "blocked", "not-applicable"):
            issue(where, "unknown decision")
            continue
        counts[decision] += 1
        if not nonempty(case.get("reason")):
            issue(where, "human reason required")
        if decision == "not-applicable":
            continue
        if decision == "blocked":
            if not nonempty(case.get("blocker")):
                issue(where, "specific blocker and recovery condition required")
            if require_complete:
                issue(where, "blocked case prevents complete acceptance")
            continue
        evidence = case.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            issue(where, "evidence array required")
            evidence = []
        revisions, live = set(), False
        for ev in evidence:
            if not isinstance(ev, dict):
                issue(where, "evidence must be objects")
                continue
            provenance = ev.get("provenance")
            if not isinstance(provenance, str) or provenance not in PROVENANCE:
                issue(where, "unknown evidence provenance")
            live |= (provenance in ("preview-live", "integration-live")
                     and nonempty(target_revision) and ev.get("revision") == target_revision)
            for field in ("reference", "revision"):
                if not nonempty(ev.get(field)):
                    issue(where, f"evidence {field} required")
            if isinstance(ev.get("revision"), str):
                revisions.add(ev["revision"])
        if require_live and not live:
            issue(where, "same-target-revision real-preview evidence required; old previews and fixtures cannot substitute")
        checks = case.get("checks")
        if not isinstance(checks, list) or not checks:
            issue(where, "observable checks required")
            checks = []
        for check in checks:
            if not isinstance(check, dict) or not nonempty(check.get("assertion")):
                issue(where, "each check requires an observable assertion")
                continue
            outcome = check.get("outcome")
            if outcome not in ("pass", "fail", "blocked"):
                issue(where, "unknown check outcome")
            if outcome in ("fail", "blocked"):
                counts["failed_checks"] += 1
                if require_complete:
                    issue(where, "failed/blocked check prevents complete acceptance")
        if decision != "fixed":
            continue
        comparison = case.get("comparison")
        if not isinstance(comparison, dict):
            issue(where, "fixed case requires before/after comparison")
            continue
        for field in ("old_failure", "new_pass", "nonessential_reason", "target"):
            if not nonempty(comparison.get(field)):
                issue(where, f"comparison {field} required")
        before, after = comparison.get("before"), comparison.get("after")
        if not isinstance(before, dict) or not isinstance(after, dict):
            issue(where, "comparison before and after must be objects")
            continue
        for side in (before, after):
            for field in ("revision", "dataset", "theme", "role"):
                if not nonempty(side.get(field)):
                    issue(where, f"comparison {field} required on both sides")
            if not isinstance(side.get("revision"), str) or side.get("revision") not in revisions:
                issue(where, "both comparison revisions need referenced evidence")
            viewport = side.get("viewport")
            if (not isinstance(viewport, list) or len(viewport) != 2
                    or any(type(x) is not int or x <= 0 for x in viewport)):
                issue(where, "viewport requires two positive integer dimensions")
            for field in METRICS:
                value = side.get(field)
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    issue(where, f"comparison {field} requires finite nonnegative measurement")
        for field in ("dataset", "viewport", "theme", "role"):
            if before.get(field) != after.get(field):
                issue(where, f"comparison {field} differs; cannot claim same-condition improvement")
        if require_live and after.get("revision") != target_revision:
            issue(where, "comparison after revision must match target_revision")
    for page, required in pages.items():
        for state in sorted(required):
            if (page, state) not in observed:
                issue("coverage", f"missing {page} / {state}")
    return errors, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--require-live", action="store_true")
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    try:
        ledger = json.loads(args.ledger.read_text(encoding="utf-8"))
        errors, counts = validate(ledger, args.require_live, args.require_complete)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Cannot read ledger: {type(exc).__name__}\n")
    print(json.dumps({"coverage": counts, "structure_ok": not errors,
                      "ux_verdict": "not-assigned", "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
