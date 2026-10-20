#!/usr/bin/env python3
"""Verify and restore the tutorial handoff ZIP from GitHub-sized parts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile


def restore(root, output):
    manifest = json.loads((root / "handoff-manifest.json").read_text(encoding="utf-8"))
    output.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total = 0
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as target:
            temporary = Path(target.name)
            for part in manifest["parts"]:
                name = part["name"]
                if Path(name).name != name:
                    raise ValueError("Invalid part filename")
                part_digest = hashlib.sha256()
                part_size = 0
                with (root / name).open("rb") as source:
                    while block := source.read(1024 * 1024):
                        part_digest.update(block)
                        digest.update(block)
                        part_size += len(block)
                        target.write(block)
                if part_size != part["bytes"] or part_digest.hexdigest() != part["sha256"]:
                    raise ValueError(f"Part verification failed: {name}")
                total += part_size
        if total != manifest["bytes"] or digest.hexdigest() != manifest["sha256"]:
            raise ValueError("Archive verification failed")
        os.replace(temporary, output)
        temporary = None
        return output
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / "testing-tutorial-handoff.zip")
    args = parser.parse_args()
    print(restore(root, args.output.resolve()))


if __name__ == "__main__":
    main()
