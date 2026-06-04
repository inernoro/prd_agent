# 网页托管 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-03 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 5 |
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

### 零重传直接生效（2026-06-03，存量回填）

用户要求：不能让大家重新上传才生效，要对**存量 PPT 直接生效**。

- **否决「访问时后端代理注入」**：托管内容现从独立域名 `cfi.miduo.org` 经 iframe 加载，
  与主站跨域隔离——这是故意的，防止用户上传的任意 HTML 触达主站登录态。若改为主站同源
  代理注入，等于让任意上传 HTML 读到访客 token（XSS 级安全回归）。故否决。
- **采用「存量回填」**（保持隔离域名 + 零安全回归 + 用户零操作）：
  - `HostedSite.SlideNavCompatVersion` 版本号；上传/重传写当前版。
  - `InjectSlideNavCompat` 改「先剥离任何旧版本注入块、再插当前版」，垫片升级时替换旧块。
  - `BackfillSlideNavCompatAsync`：版本落后/缺失的站点 HTML 从 COS 拉回重注入、原地覆盖、
    bump `ContentVersion`+`SiteUrl`（?v 击穿缓存）、升级版本号；幂等。
  - 接入 `HostedSiteBackfillService` startup 任务（30s 延迟 + 异常隔离）。
  - 垫片代码以后升级只需 `SlideNavVersion`+1，下次启动自动把存量换新版。
- **回填债务**：首次启动会下载+重传所有版本落后站点的 HTML（无批量限流），站点量极大时
  startup IO 偏重；后续启动因版本号已升级而跳过。必要时可加分批/节流或异步队列。

### 实现演进（重要）

- v1（首版）：框架感知（reveal/swiper/impress）→ scroll-snap → 合成左右方向键兜底。
  **缺陷**：真实用户 PPT 是 `<deck-stage>` 自定义元素 deck，它忽略 `isTrusted=false` 的
  合成事件，导致合成兜底无效；且垫片 stopPropagation 掉了 deck 原生可用的 Space/PageDown，
  反而帮倒忙。（首版用合成测试 deck「验收通过」是假象——合成 deck 不校验 isTrusted。）
- v2（当前）：改「可靠驱动优先」`resolveDriver()`：reveal/swiper/impress API +
  **任意标签含 `-` 且暴露 `next()/prev()` 的自定义元素** + 横向 scroll-snap 直驱。
  只有解析到可靠驱动才接管 + preventDefault/stopPropagation；无可靠驱动时只对上下方向键
  尽力合成且**不抑制原生**（不再废掉原生可用键）。
- v3：分档 + 透明可控 —— 高可信自动开 + 角落可关提示条；低可信(.slide≥2)仅邀请。
- v4（当前）：**一律邀请式（零自动劫持）** —— 按用户选择，任何幻灯片默认都不自动接管键盘，
  只在 iframe 角落弹邀请条「幻灯片：上下键翻页? · 开启」，用户主动点才绑定键盘；
  选择记入 `sessionStorage` 按 deck 记住（本会话内再开同 deck 直接生效）。彻底消除
  「静默注入 JS 劫持按键」的顾虑——不点就完全不碰任何键，误判普通页也零影响。

### 已知边界（open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 1 | reveal.js 带纵向子页（vertical stacks）的 deck，垫片调 `Reveal.next()/prev()`（按阅读顺序前进），而非 reveal 原生的「进入纵向子页」 | 极少数依赖纵向栈结构的 reveal deck，上下键语义被改为「统一前进」。为保证「上下键一定能翻页」的刻意取舍 | 若有反馈，对 reveal 改用 `Reveal.down()/up()` 优先、`next()/prev()` 兜底 |
| 2 | 既无任何可识别驱动（reveal/swiper/impress/带 next-prev 的自定义元素/scroll-snap 全不命中）、又忽略 `isTrusted=false` 合成事件的纯 JS deck，用户点「开启」后上下键兜底仍可能不生效 | 长尾 deck（v4 起为邀请式，需用户主动点开启）。此时不破坏原生键，只是开启后上下键无增益 | 评估直接 DOM 滚动或探测 deck 内部 index 字段 |
| 5（v4 已缓解） | 误判普通网页为幻灯片（主要靠 `.slide≥2` 松散启发） | v4 起一律邀请式，不点「开启」就完全不绑定键盘，误判最多多显示一个可忽略的角落邀请条，**不再劫持任何键** | 可进一步给邀请条加「不是幻灯片?隐藏」 |
| 3 | 仅覆盖用户上传路径（CreateFromHtml / Zip / Reupload），未覆盖 API/工作流生成内容（CreateFromContentAsync） | 工作流生成的周报类幻灯片不享受兼容 | 按需扩展到 CreateFromContentAsync 或改 CapsuleExecutor 模板 |
| 4（已解决） | ~~垫片随上传注入一次，历史站点不含垫片需重传~~ | 已由 startup 存量回填解决（见上「零重传直接生效」），老 PPT 无需重传自动生效 | 遗留：回填首启 IO 偏重，无批量限流 |

### 测试状态

- CDS 远端编译通过 + API/admin 容器 running（compile + boot 已验证）
- 端到端浏览器取证（2026-06-03，Playwright）：
  - **真实用户 PPT（`<deck-stage>` 自定义元素，原生只认左右键、上下键无效）**：经 v2 垫片后
    ArrowDown 连按 `_index` 0→1→2→3、ArrowUp→2、PageDown→3、Space→4→5，零 console 错误。
    完整部署路径验证（线上 API 注入 → COS → 浏览器）通过。
  - 负向：普通长文页面 ArrowDown 仍触发原生滚动（scrollY 0→120），垫片未接管 —— 保守判定生效。
  - 注入校验：marker 出现 1 次、原 deck 内容完整保留。
  - **存量回填取证（2026-06-03）**：用户原始 PPT（站点 264dfc，**从未重传**）经 startup
    backfill 后，COS 文件 marker=1、`?v` 已 bump；Playwright 直测该线上文件 ArrowDown
    `_index` 0→1→2、ArrowUp→1，零 console 错误 —— 零重传直接生效已验证。
