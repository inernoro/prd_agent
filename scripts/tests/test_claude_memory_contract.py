#!/usr/bin/env python3
"""Guard: Claude Code memory-file contract (CLAUDE.md + .claude/rules/).

Why this exists
---------------
`.claude/rules/*.md` scope themselves with a `paths:` frontmatter key. Two failure
modes are silent — nothing errors, nothing goes red, the rule just stops working:

  1. Wrong key name. The repo used `globs:` for months. Claude Code only honours
     `paths:`, so all 52 rules loaded unconditionally every session and the
     "按需加载" claim in CLAUDE.md was false the whole time.

  2. Dead glob. A pattern matching zero files turns an always-loaded rule into a
     never-loaded one. That is strictly worse than having no frontmatter at all,
     and it is invisible without a check like this one.

Run: python3 scripts/tests/test_claude_memory_contract.py
"""
from __future__ import annotations

import glob
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
RULES_DIR = REPO / ".claude" / "rules"

# Claude Code strips block-level HTML comments before injecting memory files,
# so they cost no context. Only the remaining lines count against the budget.
MAX_INJECTED_LINES = 200

FRONTMATTER_KEY = "paths"
# Keys seen in the wild that Claude Code does NOT honour. Listing them by name
# gives a far better failure message than a generic "unknown key".
BAD_KEYS = {
    "globs": "Claude Code honours `paths:`, not `globs:` (see docs/en/memory).",
    "glob": "Claude Code honours `paths:`, not `glob:`.",
    "applyTo": "`applyTo:` is Copilot syntax; Claude Code uses `paths:`.",
}

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def strip_html_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)


def split_frontmatter(text: str) -> str | None:
    """Return the raw frontmatter block, or None if the file has none."""
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    return parts[1] if len(parts) >= 3 else None


def expand_braces(pattern: str) -> list[str]:
    """Expand `a{b,c}d` -> [abd, acd]. Python's glob has no brace support."""
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    out: list[str] = []
    for option in m.group(1).split(","):
        out += expand_braces(pattern[: m.start()] + option + pattern[m.end() :])
    return out


def glob_hits(pattern: str) -> int:
    total = 0
    for expanded in expand_braces(pattern):
        total += len(glob.glob(str(REPO / expanded), recursive=True))
    return total


def check_rules() -> None:
    rule_files = sorted(RULES_DIR.glob("*.md"))
    if not rule_files:
        fail(f"no rule files found under {RULES_DIR}")
        return

    scoped = 0
    for f in rule_files:
        rel = f.relative_to(REPO)
        text = f.read_text(encoding="utf-8")
        fm = split_frontmatter(text)

        if fm is None:
            # Unconditional rule: allowed on purpose for cross-cutting behaviour
            # rules, but it must not *look* scoped.
            for bad in BAD_KEYS:
                if re.search(rf"^\s*{bad}\s*:", text, re.MULTILINE):
                    fail(f"{rel}: `{bad}:` appears outside a frontmatter block; it will be ignored.")
            continue

        for bad, why in BAD_KEYS.items():
            if re.search(rf"^\s*{bad}\s*:", fm, re.MULTILINE):
                fail(f"{rel}: frontmatter uses `{bad}:` -> the rule loads unconditionally. {why}")

        if not re.search(rf"^\s*{FRONTMATTER_KEY}\s*:", fm, re.MULTILINE):
            fail(f"{rel}: has frontmatter but no `{FRONTMATTER_KEY}:` key.")
            continue

        scoped += 1
        patterns = re.findall(r'^\s*-\s*"([^"]+)"', fm, re.MULTILINE)
        if not patterns:
            fail(f'{rel}: `{FRONTMATTER_KEY}:` has no quoted patterns (each entry must be `- "glob"`).')
            continue

        for pattern in patterns:
            if glob_hits(pattern) == 0:
                fail(
                    f"{rel}: dead glob {pattern!r} matches no file. "
                    "The rule would never load - worse than leaving it unconditional."
                )

    print(f"  rules: {len(rule_files)} total, {scoped} path-scoped, {len(rule_files) - scoped} unconditional")


def check_intro_lines() -> None:
    """Every rule carries a two-line preamble so readers can skip it in one glance."""
    for f in sorted(RULES_DIR.glob("*.md")):
        body = f.read_text(encoding="utf-8")
        fm = split_frontmatter(body)
        if fm is not None:
            body = body.split("---", 2)[2]
        head = "\n".join(body.splitlines()[:8])
        for marker in ("**一句话**", "**什么时候撞上**"):
            if marker not in head:
                fail(f"{f.relative_to(REPO)}: missing `{marker}` in its first 8 lines (导读两行).")


def check_claude_md_size() -> None:
    for md in [REPO / "CLAUDE.md", *sorted(REPO.glob("*/CLAUDE.md"))]:
        if not md.exists():
            continue
        injected = strip_html_comments(md.read_text(encoding="utf-8"))
        lines = len(injected.splitlines())
        rel = md.relative_to(REPO)
        if lines > MAX_INJECTED_LINES:
            fail(
                f"{rel}: {lines} injected lines exceeds the {MAX_INJECTED_LINES}-line target. "
                "Move detail into a path-scoped rule, a skill, or an HTML comment."
            )
        else:
            print(f"  {rel}: {lines} injected lines")


def check_no_stale_index() -> None:
    """The old 架构规则索引 table drifted to 33 of 52 rules before it was removed.

    Rules self-describe via their 导读两行, so re-adding a hand-maintained table
    means re-adding a third copy that nobody updates. If someone wants it back,
    it has to come with its own coverage assertion.
    """
    text = (REPO / "CLAUDE.md").read_text(encoding="utf-8")
    listed = set(re.findall(r"`([a-z0-9-]+\.md)`\s*\|", text))
    on_disk = {p.name for p in RULES_DIR.glob("*.md")}
    tabled = listed & on_disk
    if tabled and tabled != on_disk:
        missing = sorted(on_disk - tabled)
        fail(
            f"CLAUDE.md lists {len(tabled)} rule files in a table but {len(on_disk)} exist. "
            f"Missing: {missing[:5]}{'...' if len(missing) > 5 else ''}. "
            "Either list all of them or drop the table."
        )


def main() -> int:
    print("Claude memory contract:")
    check_rules()
    check_intro_lines()
    check_claude_md_size()
    check_no_stale_index()

    if failures:
        print(f"\nFAIL ({len(failures)} problem(s)):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nOK all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
