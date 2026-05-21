# ReactBits Components

Files in this directory are vendored verbatim from
[ReactBits](https://reactbits.dev) (https://github.com/DavidHDev/react-bits),
released under the **MIT + Commons Clause** license. ReactBits is explicitly
designed for copy-and-paste usage; we keep the originals untouched so we can
diff against upstream when they evolve.

If you need to tweak behaviour for this project, do it in a wrapper component
elsewhere (e.g. `marketplace/MarketplaceCard.tsx`) instead of mutating the
files here. That way `git diff origin upstream/main` keeps showing exactly what
upstream changed.

## Vendored files

| File | Upstream | Variant |
|------|----------|---------|
| `SpotlightCard.tsx` | `src/ts-tailwind/Components/SpotlightCard/SpotlightCard.tsx` | TS + Tailwind |
| `PixelCard.tsx` | `src/ts-tailwind/Components/PixelCard/PixelCard.tsx` | TS + Tailwind |
| `BlurText.tsx` / `CountUp.tsx` / `DecryptedText.tsx` / `ShinyText.tsx` / `SplitText.tsx` | same path tree | TS + Tailwind |

## Attribution

Copyright (c) 2024 David Haz Dev. Licensed under MIT + Commons Clause —
see https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md for full text.
