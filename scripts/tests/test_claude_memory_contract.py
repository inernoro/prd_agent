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


def resolve_imports(md: pathlib.Path, depth: int = 0, seen: set | None = None) -> str:
    """Inline `@path` imports the way Claude Code does before measuring size.

    Imported files are expanded into context at launch, so a CLAUDE.md that is
    three lines of `@AGENTS.md` still costs whatever AGENTS.md costs. Measuring
    the raw file would turn this budget check into a false pass the moment
    anyone adopts the import pattern.

    Import parsing skips code spans and fenced blocks, and stops at 4 hops.
    """
    seen = seen if seen is not None else set()
    if depth > 4 or md in seen or not md.exists():
        return ""
    seen.add(md)

    out, fenced = [], False
    for line in strip_html_comments(md.read_text(encoding="utf-8")).splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            out.append(line)
            continue
        m = re.match(r"^\s*@([^\s`]+)\s*$", line) if not fenced else None
        if m:
            out.append(resolve_imports((md.parent / m.group(1)).resolve(), depth + 1, seen))
        else:
            out.append(line)
    return "\n".join(out)


def check_claude_md_size() -> None:
    for md in [REPO / "CLAUDE.md", *sorted(REPO.glob("*/CLAUDE.md"))]:
        if not md.exists():
            continue
        lines = len(resolve_imports(md).splitlines())
        rel = md.relative_to(REPO)
        own = len(strip_html_comments(md.read_text(encoding="utf-8")).splitlines())
        note = f"{lines} injected lines" + (f" (own {own} + imports)" if lines != own else "")
        if lines > MAX_INJECTED_LINES:
            fail(
                f"{rel}: {note} exceeds the {MAX_INJECTED_LINES}-line target. "
                "Move detail into a path-scoped rule, a skill, or an HTML comment."
            )
        else:
            print(f"  {rel}: {note}")


def check_no_stale_index() -> None:
    """The old 架构规则索引 table drifted to 33 of 52 rules before it was removed.

    Rules self-describe via their 导读两行, so re-adding a hand-maintained table
    means re-adding a third copy that nobody updates. If someone wants it back,
    it has to come with its own coverage assertion.
    """
    # Read through imports: the table could live in an imported AGENTS.md.
    text = resolve_imports(REPO / "CLAUDE.md")
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


def check_module_coverage() -> None:
    """A module Codex can see but Claude cannot is a silent capability gap.

    Claude Code reads CLAUDE.md and never AGENTS.md, so a module directory
    carrying only AGENTS.md hands Codex its build/verification commands and
    leaves Claude with nothing - which makes CLAUDE.md rule 5.2 ("run the
    module's checks before pushing") unfollowable, because Claude cannot know
    what to run. `llmgw/` sat in exactly that state.

    The documented fix is a CLAUDE.md that imports the AGENTS.md rather than a
    second copy that drifts, so this also rejects a CLAUDE.md that duplicates
    the AGENTS.md body instead of importing it.
    """
    skip = {"node_modules", "dist", "bin", "obj", "build", ".git", ".claude", ".Codex", ".cursor"}
    # What matters is the text that actually reaches Claude, so read through imports:
    # a root CLAUDE.md of `@AGENTS.md` still "mentions" whatever AGENTS.md mentions.
    root_text = resolve_imports(REPO / "CLAUDE.md")

    root_agents, root_claude = REPO / "AGENTS.md", REPO / "CLAUDE.md"
    if root_agents.exists():
        if not root_claude.exists():
            fail("root: has AGENTS.md but no CLAUDE.md. Claude Code never reads AGENTS.md.")
        elif "@AGENTS.md" not in root_claude.read_text(encoding="utf-8"):
            fail(
                "root CLAUDE.md does not `@AGENTS.md` import it. These two were 95% identical "
                "hand-maintained copies with no sync script, and they had already drifted "
                "(AGENTS.md knew about llmgw, CLAUDE.md did not). Import, do not duplicate."
            )

    for d in sorted(p for p in REPO.iterdir() if p.is_dir() and p.name not in skip):
        agents = d / "AGENTS.md"
        claude = d / "CLAUDE.md"
        if agents.exists() and not claude.exists():
            fail(
                f"{d.name}/: has AGENTS.md but no CLAUDE.md. Claude Code never reads AGENTS.md, "
                f"so this module's instructions are invisible to it. "
                f'Add {d.name}/CLAUDE.md containing "@AGENTS.md".'
            )
            continue
        if agents.exists() and claude.exists():
            if "@AGENTS.md" not in claude.read_text(encoding="utf-8"):
                fail(
                    f"{d.name}/CLAUDE.md exists alongside AGENTS.md but does not `@AGENTS.md` import it. "
                    "Two hand-maintained copies drift; import instead."
                )
        if claude.exists() and d.name not in root_text:
            fail(
                f"{d.name}/: has its own CLAUDE.md but the root CLAUDE.md never mentions it, "
                "so the module is invisible until someone happens to open a file inside it."
            )


def check_host_specific_rules_are_announced() -> None:
    """Rules a host cannot auto-load must be named in the shared entry point.

    `.claude/rules/` scopes itself with `paths`, so Claude Code loads a rule the
    moment it touches a matching file. Codex has no equivalent, so the only way
    it discovers `.Codex/rules/*` is AGENTS.md naming them. Trimming the rule
    index out of AGENTS.md silently cut that discovery path and broke
    GatewayDataDomainGuardTests, which asserts production-release-safety.md is
    named there - a contract this file did not know about until it went red.
    """
    codex_rules = REPO / ".Codex" / "rules"
    agents = REPO / "AGENTS.md"
    if not codex_rules.is_dir() or not agents.exists():
        return
    text = agents.read_text(encoding="utf-8")
    for rule in sorted(codex_rules.glob("*.md")):
        # A bare mention counts; so does `.Codex/rules/<name>`. A longer unrelated
        # path that merely ends in the same filename does not - `doc/rule.platform.
        # production-release-safety.md` would otherwise satisfy this check by
        # coincidence, leaving the rule itself unannounced.
        announced = any(
            m.group(1) in ("", ".Codex/rules/")
            for m in re.finditer(rf"([\w./-]*?){re.escape(rule.name)}", text)
        )
        if not announced:
            fail(
                f".Codex/rules/{rule.name} is not named in AGENTS.md (a longer path "
                "ending in the same filename does not count). Codex has no path-scoped "
                "loading, so an unannounced rule is one it never reads."
            )


def main() -> int:
    print("Claude memory contract:")
    check_host_specific_rules_are_announced()
    check_rules()
    check_intro_lines()
    check_claude_md_size()
    check_no_stale_index()
    check_module_coverage()

    if failures:
        print(f"\nFAIL ({len(failures)} problem(s)):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nOK all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
