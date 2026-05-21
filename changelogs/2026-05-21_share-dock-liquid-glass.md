| feat | prd-admin | ShareDock 投放面板真液态大玻璃改用 SVG feDisplacementMap + backdrop-filter 实现：直接折射真 DOM 内容（iOS 26 / macOS 26 Liquid Glass 同路线），不再用 WebGL 球体（之前球体会挡住面板内容） |
| feat | prd-admin | 新增 `components/effects/LiquidGlassSurface.tsx` 通用真玻璃面：blur / saturation / distortion 三参数可调；Chromium 启用 SVG 折射，Safari/Firefox 自动降级到 blur+saturate；不依赖 R3F/three，零 WebGL bundle 增量 |
| perf | prd-admin | WebPagesPage 包体积 198KB → 52KB（gzip 62KB → 15KB），不再为投放面板单独引入 three.js |
