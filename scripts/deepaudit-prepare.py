#!/usr/bin/env python3
"""Install the reviewed CDS overlay into the pinned DeepAudit fork checkout."""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys


def prepare(checkout: pathlib.Path) -> list[str]:
    checkout = checkout.resolve(strict=True)
    bundle = pathlib.Path(__file__).resolve().parents[1] / "deploy/deepaudit"
    manifest = json.loads((bundle / "upstream.json").read_text())

    def git(*args):
        return subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()

    if pathlib.Path(git("rev-parse", "--show-toplevel")).resolve() != checkout:
        raise ValueError("Checkout must be a DeepAudit Git repository root")
    if git("rev-parse", "HEAD") != manifest["commit"]:
        raise ValueError("Checkout HEAD does not match the reviewed upstream commit")
    origin = git("remote", "get-url", "origin").removesuffix(".git")
    if origin not in (manifest["repository"].removesuffix(".git"), manifest["fork"].removesuffix(".git")):
        raise ValueError("Unexpected repository origin")
    files = [path for path in sorted((bundle / "overlay").rglob("*")) if path.is_file()]
    for source in files:
        relative = source.relative_to(bundle / "overlay")
        target = checkout / relative
        if checkout not in target.resolve().parents:
            raise ValueError("Overlay path leaves checkout")
        if target.exists() and target.read_bytes() != source.read_bytes():
            raise ValueError(f"Refusing to overwrite existing file: {relative}")
    installed = []
    for source in files:
        relative = source.relative_to(bundle / "overlay")
        target = checkout / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o755 if target.suffix == ".sh" else 0o644)
        installed.append(str(relative))
    (checkout / "cds-upstream.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return installed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=pathlib.Path)
    args = parser.parse_args()
    try:
        files = prepare(args.checkout)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps({"installed": files, "forkCreated": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
