#!/usr/bin/env python3
"""Diagnostic: rules that name a real file in their body but leave it out of `paths`.

Not a CI gate. It enumerates a known, unpaid debt so the list can be regenerated
instead of going stale in a ledger — see doc/debt.platform.agent-rule-scope.md.

What it catches
---------------
A rule whose body points at a concrete file (in backticks) that its own `paths`
does not match. That rule silently fails to load in exactly the scenario it
documents. Seven rounds of automated review found these one or two at a time;
this turns that trickle into a bounded list.

What it does NOT catch
----------------------
Rules that describe their trigger in prose rather than naming files — "任何并发闸 /
队列 / 池" tells a reader that the gateway's semaphore code is in scope, but there
is no path to extract. `server-authority` and `concurrency-gate-discipline` both
miss `llmgw/**` for that reason and do not appear below. Judging those needs
reading comprehension, so a green run here does not mean the scopes are complete.

Run: python3 scripts/audit-rule-scope-gaps.py
"""
from __future__ import annotations

import glob
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
RULES = REPO / ".claude" / "rules"

# Only treat backticked text as a path when it looks like one: has a directory
# separator and a known source extension. Keeps prose and class names out.
PATH_LIKE = re.compile(
    r"`([A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-*]+)+\.(?:cs|ts|tsx|js|css|py|sh|json|yml))`"
)


def expand_braces(pattern: str) -> list[str]:
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    out: list[str] = []
    for option in m.group(1).split(","):
        out += expand_braces(pattern[: m.start()] + option + pattern[m.end() :])
    return out


def covered(target: str, patterns: list[str]) -> bool:
    """True if any pattern matches `target` (a repo-relative path)."""
    for pattern in patterns:
        for expanded in expand_braces(pattern):
            for hit in glob.glob(str(REPO / expanded), recursive=True):
                if pathlib.Path(hit).relative_to(REPO).as_posix() == target:
                    return True
    return False


def main() -> int:
    gaps: list[tuple[str, list[str]]] = []
    scoped = 0

    for f in sorted(RULES.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        if not text.startswith("---"):
            continue  # unconditional rule: no scope to be wrong about
        scoped += 1
        patterns = re.findall(r'^\s*-\s*"([^"]+)"', text.split("---", 2)[1], re.MULTILINE)
        body = text.split("---", 2)[2]

        named = sorted(set(PATH_LIKE.findall(body)))
        # Only real files: rule bodies also contain illustrative paths that never existed.
        real = [n for n in named if (REPO / n).exists()]
        missed = [n for n in real if not covered(n, patterns)]
        if missed:
            gaps.append((f.name, missed))

    for name, missed in gaps:
        print(f"{name}")
        for m in missed:
            print(f"    names but does not match: {m}")

    print(f"\n{len(gaps)} of {scoped} path-scoped rules name a file outside their own scope.")
    print("Prose-declared triggers are not checked here - see the module docstring.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
