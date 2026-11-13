#!/usr/bin/env python3
"""Build a deterministic, allowlisted skill ZIP without publishing anything."""
import argparse
import hashlib
from pathlib import Path
import zipfile

FILES = (
    "SKILL.md",
    "reference/evidence-contract.md",
    "reference/install.md",
    "scripts/check_ledger.py",
    "scripts/package_skill.py",
    "tests/test_contract.py",
)


def build(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents:
        raise ValueError("Output must be outside the skill source directory")
    entries = []
    for relative in FILES:
        path = source / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing regular source file: {relative}")
        entries.append((relative, path.read_bytes()))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, data in entries:
            info = zipfile.ZipInfo("dechrome/" + relative, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=9)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(destination.suffix + ".sha256").write_text(
        digest + "  " + destination.name + "\n", encoding="utf-8")
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    try:
        digest = build(source, args.output)
    except (OSError, ValueError) as exc:
        parser.exit(1, str(exc) + "\n")
    print(f"{digest}  {args.output}")


if __name__ == "__main__":
    main()
