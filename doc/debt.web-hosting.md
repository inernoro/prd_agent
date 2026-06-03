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

### 已知边界（open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 1 | reveal.js 带纵向子页（vertical stacks）的 deck，垫片把「下方向键」remap 成 `Reveal.next()`（按阅读顺序前进），而非 reveal 原生的「进入纵向子页」 | 极少数依赖纵向栈结构的 reveal deck，上下键语义被改为「统一前进」。这是为保证「上下键一定能翻页」的刻意取舍 | 若有用户反馈，可在 frameworkGo 里对 reveal 改用 `Reveal.down()/up()` 优先、`next()/prev()` 兜底 |
| 2 | 兜底合成的 `KeyboardEvent` 的 `isTrusted` 为 false，少数严格校验 `e.isTrusted` 的老旧 PPT 导出库会忽略合成事件 | 长尾 deck 的兜底翻页可能不生效（框架感知 + scroll-snap 两条主路径不受影响） | 评估对这类 deck 直接操作其内部 API 或 DOM 滚动 |
| 3 | 仅覆盖用户上传路径（CreateFromHtml / Zip / Reupload），未覆盖 API/工作流生成内容（CreateFromContentAsync），平台自生成幻灯片仍是 scroll-snap 上下翻页 | 工作流生成的周报类幻灯片不享受左右翻页兼容 | 按需把注入扩展到 CreateFromContentAsync 或直接改 CapsuleExecutor 模板 |

### 测试状态

- CDS 远端编译通过 + API/admin 容器 running（compile + boot 已验证）
- 浏览器内真实 deck 的翻页行为（上下键是否真的翻页）尚未端到端取证——需上传样例 deck 后用 Playwright 直连预览域名验收，或真人上传 PPT 验证
