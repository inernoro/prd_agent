---
name: surface-style-migration
description: Use when migrating prd-admin React/Tailwind styles to the unified Surface System, reducing inline styles and hard-coded colors, reviewing style debt, or preparing module-by-module style cleanup plans. Applies to Surface, token utilities, design components, and the style-debt scanner. Avoids modules under active external ownership unless explicitly approved.
---

# Surface Style Migration

Use this skill to make `prd-admin` visually cleaner and more consistent without breaking complex interactive pages.

## First Checks

Run these before editing:

```bash
git status --short
pnpm --prefix prd-admin run style:debt -- --top 20
```

Identify active ownership from the user or branch context. Do not touch modules currently owned by another developer. In this repo, `prd-admin/src/pages/report-agent` is treated as an owned/blocked area unless the user explicitly asks to migrate it.

## Migration Order

Prefer small vertical slices:

1. Shared style foundations: `src/styles/*`, `src/components/design/*`.
2. Owned product modules with high visual payoff.
3. Leaf components inside a module before page-wide rewrites.
4. Large canvas/editor/chat surfaces only after isolating stable subcomponents.

Avoid broad mechanical rewrites across unrelated modules.

## What To Replace

Use the existing Surface System:

- Outer card/panel/dialog container: `Surface` with `variant="default"` or `variant="raised"`.
- Nested panel, chart frame, form section, empty block: `Surface variant="inset"` or `.surface-inset`.
- Table/list row hover state: `Surface variant="row"` or `.surface-row`.
- Clickable card: `Surface variant="interactive"`.
- Reading-heavy content: `Surface variant="reading"`.
- Custom modal overlay: `.surface-backdrop`.
- Text colors: `.text-token-primary`, `.text-token-secondary`, `.text-token-muted`, `.text-token-muted-faint`, `.text-token-accent`, `.text-token-success`, `.text-token-warning`.
- Repeated subtle borders/backgrounds: `.border-token-subtle`, `.bg-token-nested`.

Prefer existing design components from `src/components/design` over new one-off CSS.

## What Not To Replace Blindly

Keep inline or local dynamic styles when they are genuinely runtime-driven:

- Per-icon/per-category hue gradients such as `hsla(${hue}, ...)`.
- Canvas, drag/resize, absolute positioning, zoom, transforms, and measured dimensions.
- Chart/data colors where the color encodes data meaning.
- User-generated visual previews, poster/editor surfaces, and image/crop tools.
- One-off animation timing when it is part of an interaction.

Do not chase a zero debt score. The goal is a consistent admin surface language with explicit exceptions.

## Editing Rules

- Keep edits inside the target module unless adding shared primitives.
- Convert container-level `background + border + boxShadow` first; this gives the most visible cleanup.
- Convert repeated text color styles next.
- Leave semantic status colors readable and intentional.
- Remove `onMouseEnter/onMouseLeave` style mutation when a CSS class can express the same hover state.
- Do not mix nested cards inside cards; use inset surfaces for secondary regions.
- Keep dynamic styles as small as possible and pair them with stable classes.

## Validation

After each slice:

```bash
pnpm --prefix prd-admin build
pnpm --prefix prd-admin run style:debt -- --top 10
```

Report:

- Files changed.
- Modules intentionally avoided.
- Debt score delta and top remaining hotspots.
- Build result and any existing warnings.

## Done Criteria

A migration slice is complete when:

- Build passes.
- The scanner score improves or the exception is documented.
- The UI uses shared Surface/token classes for ordinary admin panels.
- Complex runtime visual styles are left intentional, not accidentally rewritten.
