# 网页托管 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-03 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 3 |
| in-progress | 0 |
| paid | 0 |

模块范围：`prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs`、
`prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs`、
`prd-admin/src/pages/WebPagesPage.tsx`、`prd-admin/src/pages/ShareViewPage.tsx`。

---

## 幻灯片翻页方向兼容垫片（2026-06-03 引入）

`InjectSlideNavCompat()` 在用户上传幻灯片类 HTML 时注入运行时垫片，让只认左右
方向键的 PPT 导出页也能用上下方向键 / 空格 / PageUp-Down / 滚轮 / 触摸翻页。
跨域 iframe 决定了只能从内容内部解决（父页面抓不到 iframe 键盘事件），故随内容下发。

### 实现演进（重要）

- v1（首版）：框架感知（reveal/swiper/impress）→ scroll-snap → 合成左右方向键兜底。
  **缺陷**：真实用户 PPT 是 `<deck-stage>` 自定义元素 deck，它忽略 `isTrusted=false` 的
  合成事件，导致合成兜底无效；且垫片 stopPropagation 掉了 deck 原生可用的 Space/PageDown，
  反而帮倒忙。（首版用合成测试 deck「验收通过」是假象——合成 deck 不校验 isTrusted。）
- v2（当前）：改「可靠驱动优先」`resolveDriver()`：reveal/swiper/impress API +
  **任意标签含 `-` 且暴露 `next()/prev()` 的自定义元素** + 横向 scroll-snap 直驱。
  只有解析到可靠驱动才接管 + preventDefault/stopPropagation；无可靠驱动时只对上下方向键
  尽力合成且**不抑制原生**（不再废掉原生可用键）。

### 已知边界（open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 1 | reveal.js 带纵向子页（vertical stacks）的 deck，垫片调 `Reveal.next()/prev()`（按阅读顺序前进），而非 reveal 原生的「进入纵向子页」 | 极少数依赖纵向栈结构的 reveal deck，上下键语义被改为「统一前进」。为保证「上下键一定能翻页」的刻意取舍 | 若有反馈，对 reveal 改用 `Reveal.down()/up()` 优先、`next()/prev()` 兜底 |
| 2 | 既无任何可识别驱动（reveal/swiper/impress/带 next-prev 的自定义元素/scroll-snap 全不命中）、又忽略 `isTrusted=false` 合成事件的纯 JS deck，上下键兜底可能不生效 | 长尾 deck（已大幅收窄：自定义元素只要暴露 next/prev 就走可靠驱动）。此时不破坏原生键，只是上下键无增益 | 评估直接 DOM 滚动或探测 deck 内部 index 字段 |
| 3 | 仅覆盖用户上传路径（CreateFromHtml / Zip / Reupload），未覆盖 API/工作流生成内容（CreateFromContentAsync） | 工作流生成的周报类幻灯片不享受兼容 | 按需扩展到 CreateFromContentAsync 或改 CapsuleExecutor 模板 |
| 4 | 垫片随上传**注入一次**，已存在的历史托管站点（上传早于本功能）不含垫片 | 老 PPT 需重新上传一次才生效 | 评估 serve 期注入或一次性回填 |

### 测试状态

- CDS 远端编译通过 + API/admin 容器 running（compile + boot 已验证）
- 端到端浏览器取证（2026-06-03，Playwright）：
  - **真实用户 PPT（`<deck-stage>` 自定义元素，原生只认左右键、上下键无效）**：经 v2 垫片后
    ArrowDown 连按 `_index` 0→1→2→3、ArrowUp→2、PageDown→3、Space→4→5，零 console 错误。
    完整部署路径验证（线上 API 注入 → COS → 浏览器）通过。
  - 负向：普通长文页面 ArrowDown 仍触发原生滚动（scrollY 0→120），垫片未接管 —— 保守判定生效。
  - 注入校验：marker 幂等出现 1 次、位于 `</body>` 前、原 deck 内容完整保留。
