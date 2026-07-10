#!/usr/bin/env python3
"""Inventory and prune redundant full LLM Gateway backups.

Dry-run is the default. Execution requires both --execute and an explicit
confirmation phrase. Small configuration snapshots are never deleted.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path


CONFIRM_PHRASE = "DELETE_REDUNDANT_FULL_BACKUPS"


@dataclass(frozen=True)
class Backup:
    path: Path
    modified_at: dt.datetime
    size_bytes: int
    archives: tuple[Path, ...]

    @property
    def day(self) -> str:
        return self.modified_at.strftime("%Y-%m-%d")

    @property
    def week(self) -> str:
        year, week, _ = self.modified_at.isocalendar()
        return f"{year}-W{week:02d}"

    @property
    def month(self) -> str:
        return self.modified_at.strftime("%Y-%m")


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def discover(root: Path, minimum_full_bytes: int) -> tuple[list[Backup], list[Backup]]:
    full: list[Backup] = []
    small: list[Backup] = []
    for path in sorted(root.glob("llmgw-*")):
        if not path.is_dir():
            continue
        archives = tuple(sorted(path.glob("*.archive.gz")))
        backup = Backup(
            path=path,
            modified_at=dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc),
            size_bytes=directory_size(path),
            archives=archives,
        )
        if archives and backup.size_bytes >= minimum_full_bytes:
            full.append(backup)
        else:
            small.append(backup)
    full.sort(key=lambda item: item.modified_at, reverse=True)
    return full, small


def select_keep(backups: list[Backup], daily: int, weekly: int, monthly: int) -> set[Path]:
    keep: set[Path] = set()
    for attribute, limit in (("day", daily), ("week", weekly), ("month", monthly)):
        seen: set[str] = set()
        for backup in backups:
            bucket = getattr(backup, attribute)
            if bucket in seen:
                continue
            if len(seen) >= limit:
                break
            seen.add(bucket)
            keep.add(backup.path)
    if backups:
        keep.add(backups[0].path)
    return keep


def verify_archive(archive: Path) -> tuple[bool, str]:
    checksum_path = archive.with_name(archive.name + ".sha256")
    if not checksum_path.exists():
        return False, f"missing checksum: {checksum_path.name}"
    parts = checksum_path.read_text(encoding="utf-8").strip().split()
    if not parts:
        return False, f"empty checksum: {checksum_path.name}"
    expected = parts[0].lower()
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    actual = digest.hexdigest()
    return (actual == expected, "ok" if actual == expected else "checksum mismatch")


def verify_backup(backup: Backup) -> tuple[bool, list[dict[str, str]]]:
    results: list[dict[str, str]] = []
    valid = bool(backup.archives)
    for archive in backup.archives:
        ok, detail = verify_archive(archive)
        valid = valid and ok
        results.append({"archive": archive.name, "status": "ok" if ok else "failed", "detail": detail})
    return valid, results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/root/backups")
    parser.add_argument("--keep-daily", type=int, default=7)
    parser.add_argument("--keep-weekly", type=int, default=4)
    parser.add_argument("--keep-monthly", type=int, default=6)
    parser.add_argument("--minimum-full-mb", type=int, default=256)
    parser.add_argument("--minimum-age-hours", type=float, default=24)
    parser.add_argument("--protect", action="append", default=["llmgw-release"])
    parser.add_argument("--json-out")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        raise SystemExit(f"backup root does not exist: {root}")
    if min(args.keep_daily, args.keep_weekly, args.keep_monthly, args.minimum_full_mb) < 0:
        raise SystemExit("retention values must not be negative")
    if args.execute and args.confirm != CONFIRM_PHRASE:
        raise SystemExit(f"--execute requires --confirm {CONFIRM_PHRASE}")

    full, small = discover(root, args.minimum_full_mb * 1024 * 1024)
    keep = select_keep(full, args.keep_daily, args.keep_weekly, args.keep_monthly)
    keep.update(root / name for name in args.protect)

    verified_backup: Backup | None = None
    verification: list[dict[str, object]] = []
    for backup in full:
        if backup.path not in keep:
            continue
        ok, details = verify_backup(backup)
        verification.append({"path": str(backup.path), "ok": ok, "archives": details})
        if ok:
            verified_backup = backup
            break

    if full and verified_backup is None:
        raise SystemExit("no retained full backup passed checksum verification; refusing prune")

    cutoff = dt.datetime.now(tz=dt.timezone.utc) - dt.timedelta(hours=args.minimum_age_hours)
    candidates = [
        backup
        for backup in full
        if backup.path not in keep and backup.modified_at <= cutoff
    ]
    reclaimed = sum(item.size_bytes for item in candidates)

    if args.execute:
        for backup in candidates:
            shutil.rmtree(backup.path)

    report = {
        "status": "executed" if args.execute else "dry-run",
        "root": str(root),
        "policy": {
            "keepDaily": args.keep_daily,
            "keepWeekly": args.keep_weekly,
            "keepMonthly": args.keep_monthly,
            "minimumFullMb": args.minimum_full_mb,
            "minimumAgeHours": args.minimum_age_hours,
        },
        "fullBackupCount": len(full),
        "smallSnapshotCount": len(small),
        "verifiedRetainedBackup": str(verified_backup.path) if verified_backup else None,
        "verification": verification,
        "kept": [str(item.path) for item in full if item.path in keep],
        "candidates": [str(item.path) for item in candidates],
        "candidateBytes": reclaimed,
        "candidateGiB": round(reclaimed / (1024 ** 3), 3),
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.json_out:
        Path(args.json_out).write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
