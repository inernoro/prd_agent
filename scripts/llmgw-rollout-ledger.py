#!/usr/bin/env python3
"""LLM Gateway rollout ledger.

The production stage runner uses this helper to keep an append-only rollout
ledger. The ledger is intentionally JSONL and secret-free so an operator can
attach it to a release ticket without exposing gateway keys.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

STAGES = [
    "shadow-start",
    "canary-intent-text",
    "canary-chat",
    "canary-streaming",
    "canary-vision",
    "canary-image",
    "canary-video-asr",
    "http-full",
]


def _load(path: str) -> list[dict]:
    if not path or not os.path.exists(path):
        return []
    entries: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            raw = line.strip()
            if not raw:
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"ERROR: invalid rollout ledger JSON at {path}:{line_no}: {exc}") from exc
            if isinstance(value, dict):
                entries.append(value)
    return entries


def _successful_stages(entries: list[dict], commit: str) -> set[str]:
    return {
        str(item.get("stage") or "")
        for item in entries
        if str(item.get("commit") or "").lower() == commit.lower()
        and str(item.get("status") or "") == "success"
    }


def validate(args: argparse.Namespace) -> int:
    stage = args.stage
    commit = args.commit.lower()
    if stage == "rollback-inproc":
        print("LLM Gateway rollout ledger: rollback does not require prior stages")
        return 0
    if stage not in STAGES:
        print(f"ERROR: unknown rollout stage: {stage}", file=sys.stderr)
        return 2
    if not commit:
        print("ERROR: rollout ledger validation requires --commit", file=sys.stderr)
        return 2

    if args.allow_out_of_order:
        print("WARN: rollout ledger order check skipped by --allow-out-of-order", file=sys.stderr)
        return 0

    entries = _load(args.ledger)
    required = STAGES[: STAGES.index(stage)]
    if not required:
        print("LLM Gateway rollout ledger: no prior stage required")
        return 0

    successful = _successful_stages(entries, commit)
    missing = [item for item in required if item not in successful]
    if missing:
        print(
            "ERROR: rollout stage order violation. "
            f"stage={stage} commit={commit} missing_success={','.join(missing)} ledger={args.ledger}",
            file=sys.stderr,
        )
        return 1

    print(f"LLM Gateway rollout ledger: prior stages satisfied for {stage}")
    return 0


def append(args: argparse.Namespace) -> int:
    if not args.ledger:
        print("ERROR: append requires --ledger", file=sys.stderr)
        return 2
    parent = os.path.dirname(args.ledger)
    if parent:
        os.makedirs(parent, exist_ok=True)

    entry = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "stage": args.stage,
        "status": args.status,
        "commit": args.commit.lower(),
        "mode": args.mode,
        "canaryStage": args.canary_stage,
        "allowlist": args.allowlist,
        "shadowFullSamplePercent": args.shadow_full_sample_percent,
        "gateBase": args.gate_base,
        "evidenceJson": args.evidence_json,
        "evidenceMarkdown": args.evidence_md,
    }
    with open(args.ledger, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True))
        fh.write("\n")
    print(f"LLM Gateway rollout ledger: appended {args.status} for {args.stage}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway rollout ledger")
    sub = parser.add_subparsers(dest="cmd", required=True)

    validate_parser = sub.add_parser("validate", help="validate stage order")
    validate_parser.add_argument("--ledger", required=True)
    validate_parser.add_argument("--stage", required=True)
    validate_parser.add_argument("--commit", default="")
    validate_parser.add_argument("--allow-out-of-order", action="store_true")
    validate_parser.set_defaults(func=validate)

    append_parser = sub.add_parser("append", help="append a rollout ledger entry")
    append_parser.add_argument("--ledger", required=True)
    append_parser.add_argument("--stage", required=True)
    append_parser.add_argument("--status", required=True, choices=["success", "failed", "rollback"])
    append_parser.add_argument("--commit", default="")
    append_parser.add_argument("--mode", default="")
    append_parser.add_argument("--canary-stage", default="")
    append_parser.add_argument("--allowlist", default="")
    append_parser.add_argument("--shadow-full-sample-percent", default="")
    append_parser.add_argument("--gate-base", default="")
    append_parser.add_argument("--evidence-json", default="")
    append_parser.add_argument("--evidence-md", default="")
    append_parser.set_defaults(func=append)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
