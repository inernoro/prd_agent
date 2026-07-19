# 界面材质系统 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-16 | **状态**：开发中

> **归属**：prd-admin 前端

## 背景

2026-07-16 用户反馈全站液态玻璃「浮肿」，要求做系统级统一材质层（像苹果 Material 一样一处调配、全站生效）。落地方案：

- `ThemeConfig.material: 'solid' | 'glass'`（默认 `solid` 素色），经 `applyThemeToDOM` 写 `<html data-material>`；
- 素色下 `computeThemeVars` 复用性能模式的实底 token（`--glass-bg-*` 变高不透明实底），`legacy.css` 的 `[data-material="solid"]` 规则全局清除 backdrop-filter 并压平 `.surface-nav-bar` / `.surface-raised` 棱光；
- `GlassCard` 素色下走 `buildObsidianStyle` 实底渲染（动画不降级）；
- 液态玻璃保留为可选材质（设置 → 皮肤设置 → 界面材质）。

落地前用 workflow 审计了 86 个含散装 `backdrop-filter` 的 tsx 文件：51 个走 token 自动接管、30 个仅装饰性遮罩（低风险）、5 个高风险（背景太透、靠 blur 才可读）已当场修复（ShareViewPage 密码门 / ShortLinkRouter 提示卡 / ArenaPage 侧栏与工具条 / LandingPage 顶栏 / WorkflowChatPanel 抽屉）。

## 未偿事项

| # | 事项 | 严重度 | 说明 |
|---|------|--------|------|
| 1 | 30 个「低风险」装饰性 blur 表面未逐一视觉复核 | P3 | 均为 dim 遮罩 / 图片上的渐变 scrim / 小角标，素色下损失的只是质感；如个别页面观感异常，按 workflow 审计清单（见 PR 描述 / commit）定点修复 |
| 2 | `labs/LiquidGlassDemoPage` 在素色材质下演示失效 | P3 | 实验室页本身就是 blur 演示，素色下 blur 被全局清除属预期；如需演示，切回液态玻璃材质即可，页内可加提示 |
| 3 | 硬编码玻璃渐变的长尾组件未迁 token | P3 | 如 `.surface-nav-bar` 首层 rgba(48,48,56) 渐变等，素色下观感可接受但未走 `--glass-bg-*`；后续「走到哪迁到哪」，与 themeHardcodeRatchet 棘轮同节奏 |
| 4 | 素色材质的浅色主题精调 | P3 | 浅色主题 token 本就是纸感实底，素色开关对其影响小；未做逐页浅色复核 |

## 完成判据

- 全站主要页面素色/玻璃双材质切换无破相（真视觉验收）；
- 长尾硬编码玻璃背景迁移到 token 或带 `data-material` 分支。
