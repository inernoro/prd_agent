# Scoring and Exceptions

## Metrics

Metric v3 keeps the old raw counts and reports three decision layers:

| Metric | Purpose | Enforcement |
|---|---|---|
| `rawMaintenanceDebt` / `score` | Original metric v2 formula across inline styles, hard-coded colors, arbitrary Tailwind values, effects, shadows, and low-contrast text | Preserve history; record and explain movement |
| `actionableThemeRisk` | Ordinary UI fixed surfaces plus precise adaptive findings outside reviewed visual scopes | Must be zero |
| `ordinaryUiRisk` | Theme correctness risk in normal pages, drawers, dialogs, tables, filters, and shared controls | Must be zero |
| `unclassifiedThemeRisk` | Findings that are neither migrated nor assigned a reviewed semantic or visual category | Must be zero |
| `intentionalVisualDebt` | Exact remaining debt inside canvas, poster, preview, data visualization, full-dark, or infrastructure scopes | Per-file ratchet |
| `semanticContrastDebt` | Fixed white text retained on an owning semantic-color surface | Syntax guard plus ratchet |
| `dynamicVisualDebt` | Runtime colors whose value carries data or editing meaning | Ratchet |
| Legacy theme metrics | Metric v2 `undeclaredThemeRisk` and adaptive submetrics | Historical bridge and global ceiling |

The raw score is not a percentage and has no natural zero. It finds
maintainability debt, not only theme bugs. A canvas can have a high raw score
and still be correct. The zero-tolerance v3 risks answer whether a user-facing
adaptive-theme defect remains.

## Decision Tree

Use this order for every hotspot:

1. Is it a full-dark product experience? Declare the narrow scope and inspect both themes.
2. Is it a canvas, poster, chart, media preview, or exported artifact? Preserve the artifact and migrate only its surrounding controls.
3. Is it an ordinary page, drawer, dialog, table, filter, or shared control? Migrate it to semantic tokens.
4. Is the remaining broad score caused by static `var(--token)` inline styles? Use the safe token-style codemod.
5. Is the remaining style dynamic or data encoded? Keep it local and record why.

This prevents the two common failure modes: flattening intentional visual work into generic surfaces, and declaring a theme problem solved while ordinary controls still contain fixed white borders or hover states.

## Exception Standard

Allow an exception only when all are true:

1. The visual area intentionally keeps the same theme-independent appearance.
2. A semantic token would change the intended artifact or data meaning.
3. The exception is narrower than the affected page whenever possible.
4. Surrounding admin controls still adapt to the active theme.
5. Both themes are visually inspected.

Whole-file classifications are limited to dedicated, single-purpose visual
components and full-dark experiences. Mixed pages must migrate their ordinary
controls or split the visual component first. Local dark islands remain
measured and their exact counts are frozen.

## Baseline Discipline

Keep three concepts separate:

- Program baseline: immutable starting point for measuring overall progress.
- Current ceiling: ratchet boundary after accepted reductions.
- Target: milestone objective, lower than the current ceiling.

Reducing one file must not authorize increasing another file. Per-file ratchets protect that boundary.

When a legitimate exception requires a baseline increase:

1. Capture the exact file and line.
2. Explain why a token is incorrect.
3. Add the narrowest explicit exception.
4. Run both themes.
5. Include the baseline diff in review.

## Repairing the Experience

When a migration attempt exposes a repeatable failure:

1. Revert or correct the smallest affected slice.
2. Identify whether classification, token choice, detection, transformation, or verification failed.
3. Add the missing guard to the scanner, codemod, test, or skill before continuing.
4. Re-run the failed case and a neighboring control case.
5. Record the score before and after the repaired method.

Do not silently change weights or exclusions to make a target pass. A scoring
change requires a new `metricVersion`, the unchanged raw formula, and a
historical bridge that reports old and new totals side by side.

## Slice Completion

A slice is complete only when:

- Target files have zero unexplained adaptive findings.
- Enforced global metrics do not rise.
- Per-file ratchets pass.
- Type, lint, tests, and build pass.
- The affected UI is inspected in light and dark themes.
