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

## 本地修改（偏离上游）

为了让 git diff 上游保持清晰，我们尽量不改 vendored 文件。已知的唯一偏离：

- `PixelCard.tsx`：新增可选 prop `autoAppear?: boolean`（默认 false，等价上游行为）。
  设为 true 时挂载即播放 appear 动画并常驻，忽略 mouseleave/blur 的 disappear。
  上游 PixelCard 是 hover-only（不 hover 画布空白），不适合"卡片身份视觉"这种
  需要像素一直可见的场景，故加此开关。相关行均带 `// 本地修改` 注释，方便升级时
  重新 cherry-pick。

## Attribution

Copyright (c) 2024 David Haz Dev. Licensed under MIT + Commons Clause —
see https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md for full text.
