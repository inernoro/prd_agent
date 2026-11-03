Source: https://github.com/Jakubantalik/transitions.dev/tree/main/skills/transitions-ui-generation
Copyright (c) 2026 Jakub Antalik / Transitions.dev. See LICENSE.txt (not MIT).

Used inside CDS, not distributed as an animation library. The dependency-free
geometry/outline/scan runtime is retained. CDS adds a pending-request hold,
a same-overlay handoff from placeholders to real DOM, a native scan resumed on
response, and a renderer-cost fallback. Completed waiting frames pause instead
of rewriting static SVG on every frame. It uses only
`skeleton` mode; the illustrative agent log and token counters are never enabled.
Styles use CDS theme tokens and keep overlays below dialogs.

Visible cards form an overlapping document-order wave (up to 320ms between the
first and last start). Real grouped cards are remeasured and the retained plane
is repositioned atomically; extra real cards also receive a synchronous scan
plane. Queued construction keeps its lightweight placeholder until it starts.
Fast responses skip decoration, and any interaction cancels the entire wave.
