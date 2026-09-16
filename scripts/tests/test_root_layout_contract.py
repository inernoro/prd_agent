#!/usr/bin/env python3
"""Guard the repository root as a small, stable set of project entrypoints."""

from __future__ import annotations

import pathlib
import subprocess
import sys


REPO = pathlib.Path(__file__).resolve().parents[2]

# Root files are intentionally explicit. Adding a new one requires deciding that
# it is a project-wide entrypoint rather than placing it in its owning module.
ALLOWED_ROOT_FILES = {
    ".cursorrules",
    ".dockerignore",
    ".editorconfig",
    ".env.template",
    ".git",
    ".gitignore",
    "AGENTS.md",
    "CHANGELOG.md",
    "CLAUDE.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "cds-compose.yml",
    "docker-compose.dev.yml",
    "docker-compose.local.yml",
    "docker-compose.yml",
    "exec_cds.sh",
    "exec_dep.sh",
    "execdep.sh",
    "fast.sh",
    "local_exec_dep.sh",
    "quick.ps1",
    "quick.sh",
    "skills-lock.json",
}

ALLOWED_ROOT_DIRECTORIES = {
    ".Codex",
    ".agents",
    ".claude",
    ".cursor",
    ".design",
    ".git",
    ".github",
    "assets",
    "cds",
    "changelogs",
    "claude-sdk-sidecar",
    "deploy",
    "doc",
    "e2e",
    "llmgw",
    "prd-admin",
    "prd-api",
    "prd-desktop",
    "scripts",
    "thirdparty",
}

FORBIDDEN_ROOT_DIRECTORIES = {
    ".design-work": ".design/",
    "e2e-tests": "e2e/manual/ or e2e/fixtures/",
    "templates": "the owning module or skill directory",
}


def is_git_ignored(entry: pathlib.Path) -> bool:
    """Return whether an untracked root entry is intentionally local-only."""
    result = subprocess.run(
        ["git", "check-ignore", "--quiet", "--", entry.name],
        cwd=REPO,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def main() -> int:
    failures: list[str] = []
    entries = sorted(REPO.iterdir(), key=lambda path: path.name)

    for entry in entries:
        if is_git_ignored(entry):
            continue

        try:
            entry.name.encode("ascii")
        except UnicodeEncodeError:
            failures.append(
                f"non-ASCII root entry {entry.name!r}; move it into its owning module and use an ASCII path"
            )

        if entry.is_symlink():
            failures.append(
                f"root symlink {entry.name!r} is not allowed; keep real project entrypoints in the repository root"
            )
        elif entry.is_file() and entry.name not in ALLOWED_ROOT_FILES:
            failures.append(
                f"unapproved root file {entry.name!r}; place it in its owning module or update the root contract"
            )
        elif entry.is_dir() and entry.name in FORBIDDEN_ROOT_DIRECTORIES:
            failures.append(
                f"legacy root directory {entry.name!r}; use {FORBIDDEN_ROOT_DIRECTORIES[entry.name]}"
            )
        elif entry.is_dir() and entry.name not in ALLOWED_ROOT_DIRECTORIES:
            failures.append(
                f"unapproved root directory {entry.name!r}; place it in its owning module or update the root contract"
            )

    if failures:
        print("root layout contract failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    root_files = sum(1 for entry in entries if entry.is_file())
    print(f"root layout contract passed: {root_files} approved files, ASCII-only top-level paths")
    return 0


if __name__ == "__main__":
    sys.exit(main())
