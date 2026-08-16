#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

STAGES = ("issued", "deployed", "verified", "revoked", "verified_after_revoke")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def main() -> int:
    parser = argparse.ArgumentParser(description="维护不含密钥值的轮换状态")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--file", required=True)
    init.add_argument("--items", required=True)
    mark = sub.add_parser("mark")
    mark.add_argument("--file", required=True)
    mark.add_argument("--item", required=True)
    mark.add_argument("--stage", choices=STAGES, required=True)
    mark.add_argument("--fingerprint")
    verify = sub.add_parser("verify")
    verify.add_argument("--file", required=True)
    args = parser.parse_args()
    path = Path(args.file)

    if args.command == "init":
        items = [item.strip() for item in args.items.split(",") if item.strip()]
        save(path, {"createdAt": now(), "items": {item: {stage: False for stage in STAGES} for item in items}})
        print(json.dumps({"items": len(items), "ready": False}))
        return 0

    data = load(path)
    if args.command == "mark":
        item = data.get("items", {}).get(args.item)
        if item is None:
            raise SystemExit(f"unknown item: {args.item}")
        target = STAGES.index(args.stage)
        missing = [stage for stage in STAGES[:target] if not item.get(stage)]
        if missing:
            raise SystemExit(f"cannot mark {args.stage}; missing: {','.join(missing)}")
        item[args.stage] = True
        if args.fingerprint:
            item["fingerprint"] = args.fingerprint
        item["updatedAt"] = now()
        save(path, data)
        print(json.dumps({"item": args.item, "stage": args.stage}))
        return 0

    incomplete = [name for name, item in data.get("items", {}).items() if not all(item.get(stage) for stage in STAGES)]
    ready = not incomplete and bool(data.get("items"))
    print(json.dumps({"ready": ready, "incomplete": incomplete}))
    return 0 if ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
