---
name: reduce-adaptive-theme-risk
description: Scan, score, prioritize, migrate, and verify prd-admin adaptive theme risks. Use when light theme borders, dividers, nested surfaces, text, or hover states are faint; when hard-coded white/dark styles leak across themes; when recording style-debt baselines or targets; or when preventing recurring dual-theme regressions.
---

# Reduce Adaptive Theme Risk

Turn a reported visual defect into a repeatable loop: measure, classify, migrate, guard, and verify.

## Start With the Baseline

Run:

```bash
git status --short
pnpm --dir prd-admin run style:debt -- --top 20 --details
pnpm --dir prd-admin run style:debt:check
```

Read `prd-admin/scripts/style-debt-baseline.json` before choosing a slice. Treat:

- `rawMaintenanceDebt` / `score` as the broad, unbounded style-debt trend.
- `actionableThemeRisk` as the primary dual-theme acceptance metric.
- `ordinaryUiRisk` and `unclassifiedThemeRisk` as zero-tolerance completion gates.
- `intentionalVisualDebt` as reviewed visual debt, not a hidden pass.
- Legacy `undeclaredThemeRisk` and `adaptiveThemeRisk` as historical continuity metrics.
- Per-file ratchet counts as the regression boundary.

Do not hide regressions by raising a baseline. Update a ceiling only after intentional exceptions are reviewed and documented.

## Classify Before Editing

Classify every finding:

1. Ordinary adaptive admin UI: migrate now.
2. Shared control or repeated component: migrate before leaf pages.
3. Intentional full-dark experience: declare a narrow scanner exception only when the whole file owns that visual identity.
4. Local dark island, canvas, chart, poster, image preview, or data-encoded color: keep dynamic visuals local, but migrate surrounding controls and dividers.
5. Embedded exported HTML or user-generated artifact: keep it outside the runtime theme contract and test the boundary.

Never mass-replace colors without this classification.
Record dedicated visual files in `prd-admin/scripts/theme-risk-classification.json`.
Every entry needs a category, a narrow scope, and a concrete rationale. A listed
file receives no unlimited waiver: its exact remaining counts are still frozen
by `themeAdaptiveBaseline.json`.

## Choose a Vertical Slice

Prioritize by:

```text
priority = confidence × reuse × user frequency × visible contrast impact
```

Prefer shared selectors, popovers, drawers, tables, filters, and nested panels. Avoid externally owned modules and unrelated dirty-worktree changes.

Set a measurable slice target:

- Target adaptive files reach zero unless an explicit exception remains.
- Global adaptive risk and every enforced submetric do not increase.
- Broad debt score trends downward or has a written explanation.

## Migrate With Semantic Tokens

Use:

- Container: `surface`, `surface-popover`, or `Surface`.
- Nested region: `surface-inset`.
- Clickable region: `surface-action` or `surface-interactive`.
- Row hover: `hover-bg-soft`.
- Divider or ordinary border: `border-token-subtle`.
- Nested background: `bg-token-nested`.
- Field: `prd-field`.
- Text: `text-token-primary`, `text-token-secondary`, or `text-token-muted`.

Preserve semantic status colors and runtime visual geometry. Keep dynamic style objects as small as possible.

## Migrate Static Token Styles Safely

The broad score counts every `style={{ ... }}` even when the value already uses a theme token. Use the repository codemod for that narrow, mechanical case:

```bash
pnpm --dir prd-admin style:tokens:migrate -- <file...>
pnpm --dir prd-admin style:tokens:migrate -- --write <file...>
```

The first command is a dry run. The second moves supported static token values into semantic utility classes. The codemod deliberately skips:

- Runtime colors or dimensions.
- Conditional style objects.
- Canvas and artifact geometry.
- Unknown properties or class expressions it cannot merge safely.

Run it on an explicitly classified file list, not the entire source tree by default. Type-check immediately after a write. If the broad score remains high after adaptive risks fall, inspect whether static token styles, arbitrary layout values, or genuine hard-coded visuals are responsible before choosing the next slice.

For recurring fixed-class and partial-inline cases, use the narrower,
classification-aware migrators. Each defaults to a dry run unless `--write` is
provided, and each skips the intentional-visual manifest:

```bash
pnpm --dir prd-admin theme:classes:migrate -- <file...>
pnpm --dir prd-admin theme:styles:migrate -- <file...>
pnpm --dir prd-admin theme:values:migrate -- <file...>
pnpm --dir prd-admin theme:text:migrate -- <file...>
```

Use them in that order. The class migrator handles fixed border, surface, and
hover utilities. The partial-style migrator extracts safe static properties.
The value migrator repairs dynamic inline fallbacks without flattening layout.
The text migrator preserves white contrast text only when the same class string
owns a semantic color surface or a media overlay.

## Guard the Problem Above the Problem

For each slice:

1. Add or tighten a theme contract test for shared or high-risk components.
2. Keep the per-file hard-code and adaptive-style ratchet green.
3. Run the baseline check so a decrease elsewhere cannot mask a new file regression.
4. Record the new score after successful migration; preserve the original program baseline for historical comparison.
5. Keep the scoring formula unchanged within a milestone. Repair the metric only as a versioned change with old and new totals recorded side by side.
6. Require `actionableThemeRisk`, `ordinaryUiRisk`, and `unclassifiedThemeRisk` to remain zero.

Read [scoring-and-exceptions.md](references/scoring-and-exceptions.md) when changing detection patterns, score ceilings, or scanner exceptions.

## Verify

Run:

```bash
pnpm --dir prd-admin exec eslint <changed-files>
pnpm --dir prd-admin tsc --noEmit
pnpm --dir prd-admin test
pnpm --dir prd-admin build
pnpm --dir prd-admin run style:debt:check
git diff --check
```

For user-visible UI, inspect the real page in both light and dark themes. Do not claim visual completion from static checks alone.

## Report

Report:

- Baseline and final `score`.
- Metric version and all three theme layers.
- Baseline and final adaptive border, surface, hover, and total risks.
- Files or modules brought to zero.
- Intentional exceptions, their narrow scope, reason, and frozen per-file ceiling.
- Tests, build, and dual-theme visual evidence.
- Next ranked hotspots.
- Any tool or rule improved because the migration exposed a repeatable failure mode.
