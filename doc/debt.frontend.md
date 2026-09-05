# 前端 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：前端五条线的欠账合成一册：设计体系迁移、材质层统一、移动端控制条过载、移动端浅色主题、导航返回行为。
**谁该读**：改前端界面的工程师；治理移动端体验的人。
**读完能做什么**：按线定位欠账，判断某个视觉问题是否已知。

---

> 本台账由 5 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## 前端 Apple 设计迁移

前端设计体系迁移交付时主动声明的工程债务，进度看板另有其文。

> Apple 设计系统迁移(PR #1133)交付时主动声明的工程债务台账。
> 进度看板(SSOT)在 [doc/plan.frontend.apple-design-migration.md](./plan.frontend.apple-design-migration.md);本台账只记「已知边界 / 后续可补 / 刻意取舍」,不重复进度。

| 状态 | 项 | 说明 | 优先级 |
|---|---|---|---|
| open | 手机轨剩余页面 | MobileToolboxView 字号/色魔数收敛(S)、MobileVisualAgentEditor 双皮肤迁移(M)、chrome 收尾(MobileFab/OverflowMenu/CompatGate/Segmented/SafeBoundary 补双皮肤) | P1 |
| open | PC 底座轨整条未开 | tokens.css 增 --ios-* 语义层、--font-body 改 SF-first、focus/accent/canvas 状态色对齐 iOS、design/* 原语色与圆角统一、硬编码清扫 hit-list。三项品牌决策已拍板(统一 iOS 蓝 / 后台内页 SF / 移动暗底纯黑),无阻塞 | P1 |
| open | AppStorePill 与 AppStorePillLabel 孪生 | 两者样式手写两份易漂移,底座0 审计已提出合并(统一走一份样式、button/span 只差外壳),本次未做 | P2 |
| open | AS_TYPE「严格 9 档」注释失真 | 实际档数已随 groupTitle(20px)扩档,appStoreTokens.ts:76 注释待订正为真实档数并收敛 | P3 |
| open | 首页近7日后端内存分桶 | /api/mobile/stats 的按日序列在内存分桶,单用户 7 日量级安全;重度用户 LLM 日志量大时可换 Mongo 聚合管道 + 索引评估(遵守 no-auto-index,索引走 DBA) | P3 |
| open | 未消费的原语 | AppStoreFeaturedCarousel/TipCard/Chips 已建但「摘要」版首页不再消费(商店范式弃用),保留给其他页(如百宝箱/发现页);若长期无消费方按 code-hygiene 清理 | P3 |
| by-design | 米多早报宫格色 #C05B3C | 非 iOS 色板,是刊系(report-design-system)赭红身份色,刻意保留不归一 | - |
| by-design | DailyPostPage 不迁移 | 纸墨刊系钉死 data-theme=light + 衬线,admin-dual-theme 明列 grandfather 例外,勿误改 | - |
| by-design | 进度条仅缺陷有 | recent-work 的 progress 只映射带状态机的实体(缺陷十态);工作区/知识库等无进度概念返回 null 不画,不造假(no-rootless-tree) | - |
| by-design | 七日柱 sqrt 缩放 | 迷你趋势柱对偏态数据用 sqrt 高度缩放(小值可见),是 sparkline 视觉选择非线性刻度;数值以旁边大数为准 | - |

## 界面材质系统

全站材质层要做到一处调配全站生效，本文记未偿事项与完成判据。

> **归属**：prd-admin 前端

### 背景

2026-07-16 用户反馈全站液态玻璃「浮肿」，要求做系统级统一材质层（像苹果 Material 一样一处调配、全站生效）。落地方案：

- `ThemeConfig.material: 'solid' | 'glass'`（默认 `solid` 素色），经 `applyThemeToDOM` 写 `<html data-material>`；
- 素色下 `computeThemeVars` 复用性能模式的实底 token（`--glass-bg-*` 变高不透明实底），`legacy.css` 的 `[data-material="solid"]` 规则全局清除 backdrop-filter 并压平 `.surface-nav-bar` / `.surface-raised` 棱光；
- `GlassCard` 素色下走 `buildObsidianStyle` 实底渲染（动画不降级）；
- 液态玻璃保留为可选材质（设置 → 皮肤设置 → 界面材质）。

落地前用 workflow 审计了 86 个含散装 `backdrop-filter` 的 tsx 文件：51 个走 token 自动接管、30 个仅装饰性遮罩（低风险）、5 个高风险（背景太透、靠 blur 才可读）已当场修复（ShareViewPage 密码门 / ShortLinkRouter 提示卡 / ArenaPage 侧栏与工具条 / LandingPage 顶栏 / WorkflowChatPanel 抽屉）。

### 未偿事项

| # | 事项 | 严重度 | 说明 |
|---|------|--------|------|
| 1 | 30 个「低风险」装饰性 blur 表面未逐一视觉复核 | P3 | 均为 dim 遮罩 / 图片上的渐变 scrim / 小角标，素色下损失的只是质感；如个别页面观感异常，按 workflow 审计清单（见 PR 描述 / commit）定点修复 |
| 2 | `labs/LiquidGlassDemoPage` 在素色材质下演示失效 | P3 | 实验室页本身就是 blur 演示，素色下 blur 被全局清除属预期；如需演示，切回液态玻璃材质即可，页内可加提示 |
| 3 | 硬编码玻璃渐变的长尾组件未迁 token | P3 | 如 `.surface-nav-bar` 首层 rgba(48,48,56) 渐变等，素色下观感可接受但未走 `--glass-bg-*`；后续「走到哪迁到哪」，与 themeHardcodeRatchet 棘轮同节奏 |
| 4 | 素色材质的浅色主题精调 | P3 | 浅色主题 token 本就是纸感实底，素色开关对其影响小；未做逐页浅色复核 |

### 完成判据

- 全站主要页面素色/玻璃双材质切换无破相（真视觉验收）；
- 长尾硬编码玻璃背景迁移到 token 或带 `data-material` 分支。

## 移动端控制条过载 治理台账

移动端页面顶部控制条堆叠过载，本文按使用强度与破损度排出治理清单与统一机制。

### 2026-07-12 全站移动端混乱度审计（第二轮）

用户以 VOC（`/team-activity`）截图为例反馈「部分页面还有这种混乱的情况」。对 21 个移动端入口可达的常用页面做了并行审计（评分 0-10：0-2 清爽 / 3-4 轻微 / 5-6 明显混乱 / 7+ 严重），本轮已修 6 页，收纳决策表已固化进 `.claude/rules/mobile-first-density.md` 原则 3。

| 评分 | 页面 | 路由 | 主症结 | 状态 |
|------|------|------|--------|------|
| 8 | 更新中心 | `/changelog` | 5 条控制条竖堆 + 卡中卡 + 三层 padding | 本轮已修 |
| 8 | 海鲜市场 | `/marketplace` | 工具条/分类/标签/banner 四叠、标签换行、密度切换噪音 | 本轮已修 |
| 8 | MD转PPT | `/md-to-ppt-agent` | 固定 340px 侧栏双窗格不塌陷，产物区压成一条缝，零移动适配 | **待办 P0**（需上下 tab 式移动布局重构，已标 limited） |
| 6 | 周报 | `/report-agent` | TabBar 上再叠分段器+周选+视图切换，换行 2-3 排 | 本轮已修 |
| 6 | 我的分享 | `/my/shares` | 三层 padding + chips 换行 + 卡中卡 | 本轮已修 |
| 5 | VOC 行为洞察 | `/team-activity` | hero 切换器 + 地图卡头两行 + 图例换行，共 4-5 条 | 本轮已修（用户点名） |
| 5 | 百宝箱 | `/ai-toolbox` | 搜索+段控+chips 三条竖堆 | 本轮已修 |
| 5 | 视觉创作列表 | `/visual-agent` | 260px Hero + pt-[8vh] 把项目网格挤出首屏 | 待办 P1（Hero 手机端减半） |
| 5 | 智识殿堂 | `/library` | pt-44/py-24 桌面级巨型间距未适配、排序 chips 换行 | 待办 P1 |
| 4 | 涌现探索 | `/emergence` | MiniMap/图例/引导 3 浮层小屏叠一团 | 待办 P2 |
| 4 | 总裁面板 | `/executive` | 卡中卡、DashCard p-4 未收紧、时间筛选被整个隐藏 | 待办 P2 |
| 3 | 知识库/缺陷/学习中心/设置/文学创作 | — | 各 1-2 条 P2 微调项（状态文字行、gap 偏大、headbar 略挤） | 待办 P2 |
| ≤2 | 首页/我的/资产/通知/早报 | — | 达标，`/daily-post` 与 `/` 为密度范本 | 无需处理 |

#### 补充：二级 tab 盲区专项（2026-07-12 用户真机截图触发的第二轮排查）

首轮审计只看了各路由**默认首屏**，用户随即在二级 tab 抓到两处崩坏。据此归纳出两个事故模式并全站扫描：
**模式 A** 定宽侧栏双栏不塌陷（`width:280` 级 rail 无断点门控 → 手机端另一栏挤成竖条）；
**模式 B** 定高容器压扁堆叠内容（`flex-1/h-full + min-h-0` 的单列 grid 在手机端保留视口定高 → 多块内容互相渗透重叠）。

| 位置 | 模式 | 状态 |
|------|------|------|
| team-activity 动态流网格 + 筛选行 | B + 控制条堆叠 | 已修（用户截图 1） |
| report-agent 团队 tab（TeamDashboard + WeekNavRail 280px） | A | 已修（用户截图 2） |
| marketplace SkillContentBrowser（260px 文件树，含公开分享页） | A | 已修 |
| report-agent 周报详情 RightRailPanel（280px 右栏） | A | 已修 |
| report-agent 设置→团队 TeamManager（280px 列表） | A | 已修 |
| doc-browser VersionHistoryModal 内芯 280px 双栏 | A（合格外壳+违规内芯） | **待办 P2**：窄屏 modal 内收单列 |
| literary-agent ArticleIllustrationEditorPage 三格定高 grid | B 存疑 | **待办 P2**：确认移动可达性后加 auto-rows-min + 滚动 |
| ccas-agent 三个二级 tab（Flow/Equipment/Prd）定高 grid + overflow-hidden | B | **待办 P2** |

防回潮：新建双栏一律 `flex-col lg:flex-row` + `w-full lg:w-[Npx]`；高度约束（`h-full`/`flex-1` + `min-h-0`）一律 `lg:` 前缀化，手机端靠页面自然滚动。审计/验收必须覆盖**每个二级 tab**，不能只看默认首屏。

### 问题这一类（不是单点）

桌面工具栏的一排排按钮在手机上 `flex-wrap` 挤成三四行，把首屏吃光，"进内容前控制条 ≤1 条"（`.claude/rules/mobile-first-density.md`）被反复违反。典型：知识库列表、知识库详情（验收报告那种 4 行按钮）、缺陷、周报、模型中心、海鲜市场。

### 治理机制（一套机制治一类，复用而非重写）

只换外壳、不动动作逻辑（onClick 与桌面同一份）：

| 原语 | 位置 | 作用 |
|------|------|------|
| `MobileOverflowMenu` | `components/mobile/MobileOverflowMenu.tsx` | 次要按钮 → 手机端「⋯ 更多」→ 底部 Sheet |
| `MobileFab` | `components/mobile/MobileFab.tsx` | 主操作（新建/创建）→ 右下悬浮按钮 |
| `MobileSegmented` | `components/mobile/MobileSegmented.tsx` | 多 tab → 一条滑动段控 |
| `MobileBottomSheet` | `components/mobile/MobileBottomSheet.tsx` | Sheet 底座（createPortal，遵循 frontend-modal） |

落地范式：桌面 `{!isMobile && <原工具栏/>}` 原样保留；手机 `{isMobile && <主操作内联 + MobileOverflowMenu + MobileFab/>}`。桌面零改动。

### 治理清单（按使用强度 + 破损度排序）

| 优先级 | 页面 | 路由 | 状态 |
|--------|------|------|------|
| P0 | 知识库详情工具栏（教程/同步/发布/关系图谱/统计/编辑…） | `/document-store` 详情 | 待办（部分在共享 `DocBrowser`，需谨慎） |
| P1 | 缺陷列表/详情工具栏 | `/defect-agent` | 待办 |
| P1 | 周报多视图工具栏（`report-agent/components/*` 多处 flex-wrap） | `/report-agent` | 待办 |
| P2 | 用户/团队 | `/users` | 待办 |
| P2 | 海鲜市场筛选 chip 行 | `/marketplace` | 待办 |
| P2 | 知识库顶部 TabBar 换行（共享 `surface-nav-content` flex-wrap，影响全站 TabBar，需评估） | 全站 | 待办（共享件，单独评估） |

### 候选文件（grep `flex-wrap` 命中，含非工具栏，迁移前需逐个甄别）

`report-agent/components/*`（10+ 处）、`open-platform/*Panel`、`ccas-agent/*`、`review-agent/*`、`ai-toolbox/components/*`、`LlmLogsPage`、`ModelManagePage`、`UsersPage`、`literary-agent/*`、`ExchangeManagePage`、`tech-doc-format-agent` 等。注意：`flex-wrap` 也用于标签云/表单，并非都是工具栏，迁移前先确认是"按钮工具栏"。

### 防回潮

- 新页工具栏一律走上面四个原语；`mobile-first-density` 规则补一条"工具栏必须用 MobileOverflowMenu/Fab/Segmented 承载"。
- 共享件（`DocBrowser` 的读/编工具栏、`TabBar` 的换行）改动影响多消费方，单独评估、单独验收，不与单页迁移混做。

### 已知边界

- 知识库详情工具栏里「目录/返回/全屏/批注栏/内联/评论/历史版本/编辑」大多来自共享 `DocBrowser`（3 处复用），改它等于改 3 个消费方，必须按共享件流程谨慎处理，列在 P0 但单独排期。
- 移动端 FAB 暂未承接桌面创建按钮上的 `data-tour-id="document-store-create"` 锚点，移动端该步教程定位待补（低优先）。

## 移动端全局浅色主题

移动端浅色主题落地后，仍有页面写死深色导致白底浮暗卡，本文记清扫清单与系统级机制。

### 背景

2026-07-12 移动首页定稿浅色为默认（`mobileThemeStore`，浅/暗可切换），AppShell 在移动端
按偏好把 `<html data-theme="light">` 全局落下（按路由重申）。壳层（顶栏 / MobileTabBar /
快速创建抽屉）与走 `tokens.css` token 的页面已随之变白；但站内存在大量**硬编码暗色**的页面
（inline `rgba(255,255,255,x)` 表面、`#0f1014` 类底色），这些页面在浅色偏好下仍呈暗色或出现
「暗卡浮在白底」的混搭。

### 债务清单

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | 移动端各页面硬编码暗色清理 | 浅色偏好下 `/visual-agent`、`/defect-agent`、`/ai-toolbox` 等页面局部或整页仍是暗色 | 按页面逐个把 inline 暗色换成 token（`--bg-*`/`--text-*`）或双主题分支；优先 TabBar 五入口页（首页/浏览/知识库/我的） |
| 2 | 桌面端不受 mobileThemeStore 影响 | 桌面仍是既有暗色体系；同账号手机浅色、桌面暗色属有意设计 | 若未来桌面也要浅色默认，另行评估 tokens.css 全站覆盖度 |
| 3 | report/daily-post 自管 data-theme 与全局偏好的竞态 | 暗色偏好下进入这些页强制变浅（纸面身份），退出后由 AppShell 按路由重申恢复 | 现机制可用；若出现闪烁再收敛为「页面声明式主题请求 + 壳层仲裁」 |
| 4 | 首页宫格 tint 底在暗色形态下的层次 | 暗色形态图标块为中性底 + 彩色线稿，用户若觉得素可加低饱和 tint 底 | 待用户反馈决定 |

### 系统级机制（2026-07-12 晚落地，本台账从「逐页救火」转为「棘轮清偿」）

- 守卫：`prd-admin/src/lib/__tests__/themeHardcodeRatchet.test.ts` —— 每文件白透明/深色 hex
  计数只减不增，基线 `themeHardcodeBaseline.json`（首次量化：362 文件 / 2856 白透明 / 562 深色 hex）
- 规则：`.claude/rules/admin-dual-theme.md`（修法映射表 + 基线更新流程）
- 已清偿：海鲜市场半高/迷你密度卡（用户截图病灶）、底部 TabBar、快速创建抽屉、
  百宝箱移动版（AS_COLOR_LIGHT + useAppStoreColors）、我的/通知页

### 浮层/提示层浅色审计（2026-08-11，60 agent 编排 + 逐条对抗性验证）

起因：用户报浅色主题下 Toast「替换成功」深底深字不可读（实测对比度 1.11:1）。根因是
`glassStyles.ts` 的 `glassToast()` 把底层写死成深色 rgba，而正文走 `--text-primary`
（浅色下是深色字）——**面写死、字跟主题走**的混搭。举一反三扫全仓，扫出 54 条、
对抗性验证存活 44 条（10 条判假阳性驳回，含 1 条 `InlineCommentOverlay` 死代码路径）。

**本轮已清偿**：Toast 底层与语义前景（新增 `--toast-bg-base` / `--toast-accent-*`）；
浮层面板族统一到新增的 `--overlay-panel-bg` / `--overlay-panel-solid`
（TipsDrawer、TipCard bubble、ChangelogBell popover、划词 AI/批注/配图三浮层、
InlineCommentMargin sheet、WikilinkHoverCard、WikilinkAutocomplete、DocBrowser 移动抽屉、
MobileSafeBoundary 兜底卡、AutomationRulesPage 手动触发弹层）；PageHeader tab 凹槽
（`--tab-container-bg`）；Tooltip 箭头；代码块/Mermaid 源码统一到 `--nested-block-bg`；
原生 `select` 的浅色 `color-scheme`。

**三轮验收后的收口状态（2026-08-12）**：

| 对象 | 视觉证据 | 结论 |
|---|---|---|
| Toast 成功态、教程抽屉、Mermaid 图与源码、原生 select、批注栏（桌面+移动）、Wikilink 悬浮卡（fallback 分支） | 双主题真人截图，页脚 sha 入镜 | 已验收 |
| 划词 AI 改写浮层、划词批注输入浮层、Wikilink 联想面板 | **无**。三轮均未触发 | 见下 |

后三者连续三轮拿不到视觉证据，卡点是**触发方式**而非产品：划词依赖真实指针拖选
（`useContentSelection` 要 `window.getSelection()` 有非零 rect + mouseup/selectionchange
+ 防抖），`[[` 联想依赖真实按键序列写进 textarea；同一批里唯一 hover 触发的
Wikilink 悬浮卡三轮里成了。用 `createRange()` 或 `fill()` 这类程序化方式设选区不会
走到那条路径。下次要拿这三项的截图，必须用真实指针事件（Playwright `mouse.down/move/up`）
或真人手动，不要再用程序化选区重试。

它们当前的证据强度：`themeHardcodeRatchet` 的零容忍守卫保证这 10 个浮层面板
写死浅色前景与写死深色背景**恒为 0**（配色 100% 走 token），且 token 族本身经
Playwright 逐像素实测双主题全部 ≥4.5:1。**残余风险**：token 之外的机制（如某个
第三方子组件自带配色）导致的浅色问题，源码守卫看不见。判定为可接受，不再开新一轮验收。

**未清偿（本轮显式不做，避免一个 PR 无限扩范围）**：

| 优先级 | 位置 | 浅色下的表现 | 不在本轮的原因 |
|---|---|---|---|
| P1 | `styles/motion.css:555` `.model-map-chip` 族 | 模型地图弹窗六个能力位的模型名是 86% 白字压象牙白底，整张图只剩连线 | CSS 层，需连带核对该弹窗整体配色 |
| P1 | `styles/motion.css:926` `.sa-cancelHint` | 取消图标 55% 白压浅底几乎隐形，用户不知道长任务可取消 | 同上 |
| P1 | `styles/surface.css:3216 / 3316` `.mkt-qc-*-primary` | 海鲜市场「创建 Key」「复制」按钮淡蓝字压近白底，糊成空白色块 | 依赖 `--surface-action-primary-*` 两个 token 的浅色定义缺失，要先补 token |
| P1 | `pages/video-agent/videoConsole.css:478` | 分镜生成信息值仍是硬编码淡灰 `#c6cdd4`，面已随 token 变亮 | 半迁移残留，需整文件回填 |
| P1 | `prd-desktop` `SystemNoticeOverlay:11` / `UpdateNotification:73` | `bg-black/40` 等分支方向反了（浅色拿黑底），层内白字无 `dark:` 分支 | **prd-desktop 全仓无 `data-theme` 机制**，要先定「桌面端要不要浅色」再动，属产品决策 |
| P1 | `llmgw/web` `logsHelpers.ts:270` `deriveLifecycle()` | 生命周期 chip 前景写死暗色主题亮色，浅色下对比 1.5–1.7:1 | 网关观测台独立配色体系，需单独定 token 层 |
| P2 | `styles/base.css:106` `.prd-field` | 输入框白 7% 填充 + 白 18% 边框在浅底全部隐形，控件「消失」 | 150+ 处消费方，改动面过大，需单独 PR + 全量视觉回归 |
| P2 | `styles/surface.css:628 / 686` 百宝箱筛选条与分段控件 | 白 6%/19% 面与边隐形，选中态几乎分不出来 | 同上，成组改 |
| P2 | `llmgw/web` `logsHelpers.ts:235`、`GenerationDetailsDrawer.tsx:350` | 协议/保真度 chip 同型 | 同 llmgw 条 |
| P2/P3 | `prd-desktop` `PostUpdateSummaryModal:171`、`DefectListPage:465/482` | 深卡浮在浅页 / 白 2% 面不可见 | 同 prd-desktop 条 |

**守卫判据的已知缺口**（`themeHardcodeRatchet.test.ts`，本轮已补两条，其余待办）：

- 已补：扫描范围加 `.ts`（此前只扫 `.tsx`，配色 SSOT `glassStyles.ts` 从未被扫过）；
  新增「深色 rgba 当背景」计数，且判据按**声明的值**取而不是按行取（按行判会被 Prettier
  折行绕过，`TipCard.tsx` 的深色气泡底正是这样漏网的）。
- 待补：3 位 hex（`#111`）、`hsl()` / `oklch()` / `color-mix()` 等价写法不认；
  深色阈值卡死在感知亮度 0.15，`#292929`(0.161)、`#1f2937`(0.156) 这类中深灰整段落在判据外；
  **CSS 文件完全不在扫描范围**（基线 289 条无一个 `.css`），上表 P1 里的 motion/surface/
  videoConsole 三条正是因此从未被拦住。

### 全站程序化对比度审计（2026-08-13 收口）

源码守卫只看得见「写死的颜色字面量」，看不见**组合出来的**低对比（token 正确但叠在
错的底上、幽灵 token 让底色根本没画、动画让底色亮度来回摆）。用户当时的判词是
「我实在是找一个页面出现一个页面的错误」——逐屏人工验收接不住这一类。

因此把验收换成程序化全站扫描：`e2e/theme-contrast-audit-local.mjs` 把 `prd-admin/dist`
挂本地静态服务 + `/api/*` 空数据桩，48 条路由 × 双主题逐个跑，对**实际渲染**的文本与
图标算真实对比度（颜色一律交浏览器色彩引擎解析合成，渐变/背景图上的元素从截图里
取元素框内众数色当底）。

结果：522 → 115 → 82 → **0**。清偿的根因型缺陷（一处修好、几十屏受益）：

| 根因 | 影响面 | 修法 |
|---|---|---|
| `BranchBadge` 半透明彩底 + 浅灰字 2.93:1 | 每一屏，364 处命中 | 不透明 800 档 + 白字 7.09:1 |
| 共享 `Badge` 的 success/danger/warning 字色写死 500 档，压同色 12% 淡底 | 所有用语义徽章的页 | 改走双写 `--accent-fg-*` |
| 品牌色 `--accent-primary` 暗色档配白字只有 3.12:1 | 所有「实心填充 + 白字」按钮 | 新增 `--accent-primary-solid` + `--accent-on-solid` 配对 token |
| `var(--accent)` 幽灵 token（全仓从未定义） | 快捷指令三个主按钮无底色，白字压米白 1.2:1 | 改指真实 token |
| 页面钉死暗色画布但文字走全局 token | 前端智能体 / 竞技场 / PR 审查三页整屏反色 | 挂 `surface-tone-dark` 让内部 token 整体切暗 |
| 文字直接压在会动的呼吸渐变上 | pa-agent 顶栏，对比度随动画在 2.0~5.5 之间摆 | 顶栏铺不带呼吸层的底并抬到渐变之上 |

**覆盖边界（老实写清楚，别当成 100%）**：

- 空数据桩下扫的是**外壳、导航、页头、按钮、分段控件、图标、空状态**；列表被真实数据
  填满之后的行（卡片、表格行、头像、封面图上的文字）**没扫到**，要用远端版
  `e2e/theme-contrast-audit.mjs` 对着真站点跑才算数。
- 48 条路由里有 4 条（`/library` `/pm-agent` `/product-agent` `/visual-agent`）在浅色轮被
  跳过——这些页自己钉死 `data-theme`，浅色轮本就不成立，它们由暗色轮覆盖，不是扫描漏洞。
- 参数化路由（`/:id` 编辑器等）不在 `navRegistry` 的静态清单里，未覆盖。
- 失效控件（`disabled` / `aria-disabled`）按 WCAG 1.4.3 Incidental 例外**不计**——
  `/arena` 空阵容时的「发送」按钮 1.78:1 就属于这类，是有意不修。
- 扫描产物（截图 + 报告）不入库，跑一次脚本即重生成。

### 浏览器审计看不见的那一类：同色调淡底浅字（2026-08-14）

上一轮扫到 0 之后，用户随手翻两页就翻出海鲜市场与学习中心两屏糊的。原因不是漏扫，
是**结构性看不见**：这两屏的缺陷都在「列表被真实数据填满之后才渲染」的行里，
而本地审计跑的是空数据桩。

试过喂通用 fixture 让列表渲染 —— 失败，且失败得有价值：一份字段名的超集喂不满
带类型契约的接口，页面被喂成脏数据（`Lv.warning`、`已掌握 false`、`NaN 万次访问`），
扫出来的 0 比没扫更危险。远端版对着真站点跑本可以解决，但本沙箱的 chromium 没有出网
（curl 通、chromium `ERR_CONNECTION_RESET`，重启容器后复测仍然如此）。

所以这一类改为在**源码层**判：`sameHueTintRatchet.test.ts`。判据是
「同一色相，既当低透明度背景（≤0.3）、又当高不透明前景（≥0.7），且把淡底合成到暖纸页底后
前景对它够不到 4.5:1」。全仓扫出 **553 处 / 158 个文件** —— 这才是「翻一页坏一页」的实际规模。

判据本身返工了四轮，每一轮都是「太窄」（`predicate-and-wiring-discipline` 形状 1）：

| 轮次 | 漏在哪 | 补法 |
|---|---|---|
| 1 | 只认 `color:`/`fg:`/`stroke:` | 补 `text:`/`iconColor:` —— 注册表普遍写 `{ bg, text, border, iconColor }`，海鲜市场正栽在这 |
| 2 | 只认**完全相同**的 rgb 三元组 | 改按色相族 —— 底 400 档 + 字 300 档一眼同色，三元组却不同 |
| 3 | 把白/灰也算进来 | 无彩色（通道极差 < 40）划归 `themeHardcodeRatchet`，两条棘轮不互相打架 |
| 4 | 用「亮度 < 0.25 视为深字」拍了个魔数 | purple-500 与 pink-500 的亮度落在 0.21~0.25，卡任何魔数都漏；改成直接算真账：淡底合成到页底再算对比度 |

**结果 553 → 10**，剩下的两处都是有意保留：

- `lib/platformColors.ts` 9 处 —— 平台品牌色注册表，色值即身份，换语义 token 等于抹掉品牌；
- `pages/public-profile/RetractButton.tsx` 1 处 —— 只在 `:hover` 分支生效，按形状 8「带状态限定不能当证据」不判。

### 对比度审计：未解边界（2026-08-15）

只留**尚未解决、会影响结论可信度**的边界。已修项、修法机制、轮次过程与计数都不进本文档
（AGENTS.md §10：实现细节读源码，评测产出归验收知识库）。

| 未解边界 | 对结论的影响 |
|---|---|
| 浮层与交互态一概没扫 | 审计只做「打开路由 → 扫当前 DOM」，不点不 hover 不触发。Toast / Tooltip / 抽屉 / Popover / 悬浮卡 / 下拉 / hover 态全部在覆盖之外——而浅色主题缺陷恰恰高发于浮层。要真覆盖需给每类浮层写触发夹具，属独立工程 |
| 参数化详情页没扫 | 28 条含 `:id` 的路由要真实 id 才打得开，默认清单直接过滤掉；`AUDIT_ROUTES` 可传具体路径，但得先有真实 id |
| `background-clip: text` 的渐变文字量不出来 | 这类文字的颜色是被裁切的背景渐变本身，`color` 是 transparent，任何按 `color` 取值的判据都够不着。现按「没量成」如实计入，不猜数 |
| 滚动揭示（Reveal）内容没扫到 | 首屏以下靠 IntersectionObserver 揭示的内容，扫描时仍是 opacity:0，按「不可见」跳过。落地页 `/home` 的统计大数就是这样——它同时也是 `background-clip:text`，两条边界叠在同一处 |
| 具名 style 对象里的暗底 | 「给暗岛补 surface-tone-dark」的自动扫描按「同一开标签」判定，够不着这种写法，只能手工 grep |
| opacity 嵌套取乘积 | 多层 opacity 嵌套时按各层乘积算，与浏览器「逐层成组再混」在「半透明背景叠半透明组」的极端组合下有小数级偏差。本仓库未见两层以上嵌套 |
| 钉死主题作用域一律豁免 | 同色调棘轮扫 CSS 时，把淡底合成到暖纸页底上算真账，这个前提对钉死某一档主题的覆盖不成立，故这类声明整条豁免。目前仓库里钉死档全是深色；若将来出现按浅色档命名的钉死作用域，会被一并放过 |
| 大批实测缺陷尚未清偿 | 最后一次可信全量扫描留下约 1330 处实测不达标、312 处没量成，本轮只清掉影响面最大的几组。按路由排队：`/video-agent` 82、`/agent-launcher` 68、`/labs/liquid-glass` 61、`/pa-agent` 59、`/weekly-poster` 53 |
| 复扫通道当前不通 | 2026-08-16 起审计账号在预览域名登录被拒（接口返 `INVALID_CREDENTIALS`，非部署问题），最后几处判据修正（视口聚合键、needsEye 去重、query 核对、opacity 组合成）只在合成页验证过，未对真站点复跑。恢复复扫需要一组能登录预览域名的凭据 |
| 合并 main 时随入的硬编码 | 2026-08-16 合入 main（197 个提交）时，双皮肤棘轮与同色调棘轮各拦下一批：`ShareViewPage`、`AskConfigDrawer`（main 新建）、`AdvancedVisualAgentTab`、`ReprocessChatDrawer`。全部经 merge-base 比对确认是 main 并行期新写、且写于守卫落地之前，非本分支引入。已录进基线锁住不再增长，清偿留给触碰这些文件的下一次改动 |
| 样式表 452 处存量硬编码 | 双皮肤棘轮刚把 `.css` 纳入并录基线，新增会红；存量按「走到哪清到哪」偿还 |

**结论怎么用**：同一把尺子前后对比是可靠的；用它宣称「全站零缺陷」不可靠——上表每一行都是少报的来源。

沙箱内跑远端审计需要 chromium 走 node fetch 桥（chromium 自身穿不过出口代理），
穿透层与两个入口见本节末「实现来源」。

#### 实现来源

| 角色 | 文件 |
|---|---|
| 代理穿透层（chromium → node fetch） | `.claude/skills/cds/cli/acceptance/proxyroute.mjs` |
| 远端审计入口 | `e2e/theme-contrast-audit.mjs` |
| 本地审计入口 | `e2e/theme-contrast-audit-local.mjs` |
| 判据与采样内核 | `e2e/contrast-audit-core.mjs` |

### 已完成（本轮）

- `mobileThemeStore`（localStorage 持久化，浅色默认）+ 首页右上角明暗切换按钮
- AppShell 移动端按 `mode + pathname` 重申 `data-theme`
- MobileTabBar 与快速创建抽屉双主题化（浅色白底墨字）
- 首页 / 米多早报滚动容器隐藏滚动条（`.no-scrollbar`）

## 前端导航历史（返回上一页）

手势返回与浏览器返回常落到奇怪的页面，本文记两半根因与验收口径。

### 背景

2026-07-12 用户反馈：手机右滑返回 / 鼠标返回上一页总是落到奇怪的导航页，而不是真正跳转过来的
上一页。根因有两半：

1. **历史被污染**（多写）：tab 切换 push、创建后跳转 push、硬编码返回按钮 push 列表页。
   已落地 `prd-admin/src/hooks/useSmartBack.ts`（有站内历史弹栈、深链直达走 replace 兜底）
   并修复主要污染源（移动端 TabBar 同级互切 replace、tab/筛选 replace、创建成功跳转 replace、
   十余处返回按钮统一 useSmartBack、站内整页刷新改 SPA navigate）。
2. **该写没写**（漏写，用户指出的主因）：百宝箱/知识库/周报/涌现/技能/缺陷(移动端)/工作流执行
   七处「列表 → 详情」是纯 state 切全屏视图，URL 与历史不动，右滑返回直接跳出整个页面落回
   launcher。已落地 `prd-admin/src/hooks/useHistoryBackedView.ts`（视图开关与 ?param 双向同步：
   打开 push、手势返回 onExit、内部关闭弹栈、深链/刷新 onRestore）并接入上述 7 页。

### 债务清单

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | 教程引导跨页跳转仍 push（`SpotlightOverlay.tsx` navigateTo、`TipsDrawer`/`TipsRotator`） | 走完一套多页教程后，返回会逐步回放教程路径 | 教程步骤间跳转评估改 replace；需先确认 SpotlightOverlay 跨路由 poll 机制不受影响，故本次未动 |
| 2 | NavigationBridge（`App.tsx` bridge:navigate 事件）恒为 push | CDS Widget / 外部脚本触发的导航会压栈；属显式指令，多数场景合理 | 若出现「后台事件凭空插历史」投诉，给事件 detail 增加 replace 可选参数 |
| 3 | 百宝箱 cds-agent 条目仍走 `window.location.assign`（三处，有意保留） | 进入 CDS 终端整页刷新，路由历史序号重置，进入后首次 smart back 走兜底而非弹栈 | cds-agent 页面依赖整页环境，保留；若迁移为 SPA 内页面再回收 |
| 4 | 未逐页覆盖所有 `navigate('/xxx')` 型返回/跳转 | 长尾页面（如部分 admin 深页）可能仍有硬编码返回 | 后续「用户走到哪修到哪」，新代码一律用 useSmartBack，返回按钮禁止硬编码列表路由 |
| 7 | useHistoryBackedView 的刷新恢复按页降级 | 百宝箱 create/edit/running、工作流执行子视图依赖内存态，刷新后回落列表并清 param（不是恢复原视图）；知识库/涌现/缺陷/周报可完整恢复 | 需要完整恢复时给对应页补「按 id 拉数据」的 onRestore |
| 8 | report-agent 页内编辑器与路由版详情页仍是两套实现 | 页内 `?report=` 走 hook，路由版 `/report-agent/report/:id` 各管各 | 后续收敛为一套（倾向路由版），届时删 store 的 showReportEditor |
| 5 | prd-desktop 为 Tauri 状态机导航（无浏览器历史），不在本次范围 | 桌面端返回为 `previousMode` 单层栈，深度 1 | 若桌面端出现同类反馈，把 `sessionStore.mode` 扩展为多层栈 |
| 6 | 移动端 TabBar「同级互切 replace」依赖 FIXED_TABS 根路径集合 | 新增底部 tab 时若忘记 path 一致性，replace 判定失效 | 新增 tab 时确认 `TAB_ROOT_PATHS` 自动包含（由 FIXED_TABS 派生，通常无需手动） |

### 验收口径

真实手机（或 DevTools 移动仿真）路径：首页 → 底部 tab 互切数次 → 进入任一 Agent 详情 →
右滑/浏览器返回，应一步回到进入详情前的页面；继续返回应直接离开 tab 簇回到进入前的真实上一页，
不再逐条回放 tab 导航页。桌面路径：设置/模型管理切多个 tab 后按浏览器返回，应直接离开该页。

---

## 首页配图的「认领落位」挂在浏览器上

管理员在「系统设置 → 首页预览图」点生成时，后端起一条生图 run，前端订阅它的事件流；
每出一张图，**由前端**回调去调认领接口，把这张图挂到对应的首页槽位上。

**欠在哪**：提交认领的责任在浏览器。管理员切走页面、关标签页，或者事件流断了没能重连，
后端那条 run 照样跑完、照样花钱，但没有人去认领——七个槽位一个都不会变，
而管理员以为自己已经点过生成了。目前只有「重进这一屏再点一次」这一条出路。

**为什么不在首页重构那个 PR 里做**：真正的修法是把「哪张图落哪个槽位」随 run 一起持久化，
认领改由服务端 worker 或一条可续的对账路径完成。那是新的后端语义（谁在什么时候提交结果、
重复提交怎么办、run 与槽位的归属关系），不属于「让首页十幕不说谎」这个目标，
按规则 #5.5 归类为「有价值但扩范围」，记在这里等单独排期。

**眼下的缓解**：这一屏是管理员低频操作，且失败可见（槽位没变、卡片仍显示旧图/占位），
重跑一次即可；生成过程中页面有进度与秒表，不会让人以为已经完成。

**动手时要注意的**：槽位映射得随生图 run 一起持久化，认领从前端的事件回调搬到服务端；
而生图 run 的认领**已经**按部署作用域隔离（见 `cross-project-isolation.md` 通道 8），
新开的对账路径必须沿用同一套作用域，别再写一个只看状态的裸认领——那会让旧构建的
部署抢走新分支入队的任务，是已经踩过的坑。

**已还的一笔（2026-08-29）**：供应商的临时/签名地址曾被原样写进槽位——生成当天首页正常，
等地址过期，未登录访客看到一排裂图而管理端不报错。现在认领时**先把字节取回来存进我们自己的
存储，再写槽位**：不去判断「这个地址是不是我们的」（那种判断窄一分就漏一类，而漏掉的代价几个月后
才显形），一律复制。换来一条能一句话说清的不变量：**首页槽位引用的对象一定是我们自己存的。**
同批把出站也收紧了：那个地址来自模型供应商的响应，所以下载走安全出站客户端 + 逐跳地址校验
（跳转不自动跟，只校验第一跳等于没校验）、边读边数到上限就断开、只认字节里的图片魔数，
认不出就拒收——签名过期时对象存储回的是一页错误 XML，而且照样带着像模像样的 Content-Type。

**这一笔还留了个尾（2026-08-29，P3）**：同一个槽位的对象 key 是固定路径（`icon/title/{id}.png`
这类），认领是**原地覆盖**而不是写一个新版本再换指向。后果有两个：CDN 上那张旧图会按缓存
存活一段时间；两个管理员同时认领同一个槽位时，存储上留下的是后完成的那份字节、库里留下的
可能是另一份的 mime/大小/提示词。不在这次改的原因是那几条固定路径是**契约**——`agent.*` 与
`hero.*` 有一批老读取方直接按路径取图，换成带版本号的 key 会把它们一起打断。真要做就得连
那些读取方一起改成走库里的 `RelativePath`，属于扩范围，单独排期。

**还欠着的两笔**（2026-08-29 补，来自首页重构 PR 的第九轮评审）：

1. **列表拉不回来时，改动按钮仍然可点**（P2）。这一屏进来先拉一次现有配图与提示词；这次拉取
   失败时页面只是空着，生成/重新生成按钮照常可用。此时点下去，提示词会按默认模板重建并覆盖
   掉库里存的那份——管理员手工调过的画面描述就这么没了，而他并不知道刚才那次加载失败过。
   修法是把这一屏的写操作 gate 在「首屏数据确实到手」上，并把失败态显式画出来（带重试），
   而不是用空列表冒充「本来就没配过」。

**第二笔同源的**：**发起那一下的回应丢了，也会重复计费**。发起生成是一次普通请求，
请求本身超时或连接被重置时，前端只知道「没收到回应」——但服务端很可能已经收下并开始
生成了。当前的处理是把它当成「这个模型不行」，立刻换个模型再发一次（新的幂等键），
于是同一批图被生两遍、钱花两遍。断流那半已经修了（重试耗尽时如实说断了并停止兜底），
发起这半没有，因为它同样需要那条「按 run 状态对账」的路径才能分清「真没收到」与
「收到了但回执丢了」。修法与上面那笔一起做：对账路径建起来之后，发起失败先查一次
再决定要不要换模型。

| 状态 | 项 | 优先级 |
|---|---|---|
| done | 认领的图先落进受管存储再写槽位，杜绝临时地址过期后首页裂图（2026-08-29 已修） | P1 |
| open | 认领落位改由服务端提交，不再依赖浏览器连接 | P2 |
| open | 首屏数据拉取失败时禁用写操作并显式给失败态与重试 | P2 |
| open | 发起请求的回应丢失时先按 run 状态对账，不直接当模型失败换下一个 | P2 |
| open | 认领改为写新版本 key 再换指向（需先把按固定路径直读的老读取方改成走 RelativePath） | P3 |

---

## 首页百宝箱那一幕的名单是手抄快照

首页有一幕复刻登录后的「百宝箱」页，列了十六个 Agent。那十六条是当初手抄进文案文件的，
不是运行时从百宝箱注册表算出来的——注册表里加一个新 Agent，这一屏不会变。

**已经修掉的那半**：文案原来写着「加一个新 Agent，这里自动多一个」，在宣称一个不存在的机制；
已改成「照着注册表来的一屏，从三十几个里挑的十六个」，并加了守卫盯住剩下的部分：
列出的名字必须真在注册表里、「预览」标记必须等于注册表里的 wip、中英两份标记逐位一致
（落地时就抓到一个：CDS Agent 在注册表里是预览态，首页却当成已验收的在展示）。

**还欠着的那半**：要真做到「加一个就自动多一个」，得让这一幕从注册表生成。挡在前面的是
展示形态——这一幕的名单带着分组、图标、演示用的排序和「搜索时哪些浮上来」的编排，
注册表里没有这些，直接接过去会让这一幕退化成一列没有节奏的清单。真做要先定「分组与排序
从哪来」，属于新的展示语义，按规则 #5.5 记在这里单独排期。

**眼下够用的理由**：守卫已经把最容易漂的两件事（改名、预览转正）钉住了，漂了会 CI 红；
剩下的漂移形态是「注册表新增了 Agent 而首页没跟」，那不会让页面说谎，只是少列几个——
而这一幕本来就只列十六个，文案也已经说清是挑出来的一屏。

**动手时要注意的**：中英两份名单是分开写的，接注册表时要一起接；名字在两边不是同一套
（英文那份是意译，不是注册表里的名字），所以别只按名字对齐，得先给每条一个稳定标识。

**图标守卫只判「有没有值」，不判「这串值画不画得出来」**（2026-08-29 补）：那一幕自带一份
图标路径表，守卫已经会跑真值、认得出空串与兜底方块，但一串**语法坏掉的路径**（手抄时漏个
逗号、少个字母）仍然会被判绿——浏览器那边画出来是空的或残的。真要堵住得把路径喂给 SVG
解析器、或在真浏览器里量一次渲染结果，那是给单测引入渲染依赖，不在「让这一幕别说谎」这个
目标里，记在这里等单独排期。眼下的缓解：这十六条路径是一次性手写的，改动频率极低，且改完
必然要看那一屏。

| 状态 | 项 | 优先级 |
|---|---|---|
| open | 这一幕的名单改由注册表生成，兑现「加一个就自动多一个」 | P3 |
| open | 图标路径的语法有效性也纳入判据（需 SVG 解析或真浏览器取值） | P3 |

---

## 首页各幕的进场阈值与观察阈值对不上

首页每一幕是一段有节拍的演出：滚到这一幕才开始走，滚开就停。判断「滚到了没有」用的是浏览器的
交叉观察器，注册时声明的是「露出三成才算数」，但真正拿来做判断的是那个「有没有交叉」的布尔值——
它在**只露出一个像素**时就已经为真。

**后果不是坏，是早**：一幕会在刚探头时就开演，用户滚到能看清它的时候，前几拍已经放过去了。
指针走位与按下也跟着提前，于是「先走到、再按下、然后那件事才发生」这条因果在观感上被削掉一截。
这不会报错、不会红，只有真人滚一遍才觉得「怎么好像错过了开头」。

**为什么不在首页重构那个 PR 里改**：改判断口径会把九幕的节拍整体后移，每一幕的起拍时机、
指针走位的提前量、幕间过场的衔接都要重新对一遍并重新取证——那是一轮完整的节奏返工，
不属于「让首页十幕不说谎」这个目标，按规则 #5.5 记在这里等单独排期。

**动手时要注意的**：判断要改成读交叉比例并跟注册的阈值比，两处数值必须来自同一个常量，
别再一处写三成、另一处读布尔。改完必须真人滚一遍看每一幕的起拍，光看测试绿不算数。

| 状态 | 项 | 优先级 |
|---|---|---|
| open | 幕的进场判断改为比对交叉比例，与注册阈值同源 | P2 |

---

## 墨系色带的管辖范围（紫色到底禁到哪一层）

`lib/tileAccent.ts` 的注释写着「紫、靛、品红一律不在色带内」，读起来像全站禁令；实际是**分域**的，读注释的人很容易误判。本节把边界写死，免得下一个人要么去清一大片、要么把守卫一扩就红。

**真实边界**

| 层 | 紫色允不允许 | 依据 |
|---|---|---|
| 品类色带（卡片芯片 / 首页 / 启动器 / 移动首页） | 禁 | `inkPalette.test.ts` 守卫，判据为色相 225-340 且饱和度 ≥0.3、明度 0.12-0.92 |
| 语义色槽 | **允许** | `tokens.css` 正式定义 `--semantic-purple-soft/border`、`--semantic-indigo-soft/border/text`；守卫的 token 用例显式写「语义色槽除外」 |
| 其余业务页面 | 不受管 | 守卫的 `GUARDED` 只有 8 项：`pages/home`、`pages/MobileHomePage.tsx`、`pages/mobile-home`、`pages/AgentLauncherPage.tsx`、`styles/home-launcher.css`、`lib/tileAccent.ts`、`lib/agentAccent.ts`、`lib/appStoreTokens.ts` |

**量级**（2026-08-23 用守卫自身判据扫未受管范围）：命中 2129 处、299 个文件，头部是 `pages/library`(146)、`pages/md-to-ppt-agent`(137)、`pages/front-end-agent`(84)、`pages/report-agent`(84)、`components/doc-browser`(80)。

**这 2129 处绝大多数不是缺陷**——它们要么走语义色槽，要么根本不在色带语境里。把它当「待清理违规」处理是误读，会引发一次没有收益的大规模改色。

**真正的缺口只有一条**：部分位置**手写紫色字面量**而不是引用 `--semantic-purple-*` token，两道守卫都拦不住——`inkPalette` 因为不在 `GUARDED`，`themeHardcodeRatchet` 因为只按明度判（白透明 / 暗 hex / 浅色前景），不按色相判。

| 状态 | 项 | 说明 | 优先级 |
|---|---|---|---|
| done | 划词浮层手写紫 | `components/doc-browser/DocBrowser.tsx` 的 `SelectionActionPopover`：文字 → `var(--accent-fg-violet-strong)`、底 → `var(--overlay-panel-solid)`。棘轮 `lightFg 4→3`、`darkRgbaBg 3→2`。**描边保持字面量**（见下方陷阱），已就地加注释说明 | - |
| by-design | 划词高亮 `rgba(168,85,247,0.22)` | `scrollToTextInContainer` 把它写在正文元素上，正文跟随主题、浅色下紫底 0.22 依然可见，不需要 token 化 | - |
| open | 再加工抽屉手写紫 | `pages/document-store/ReprocessChatDrawer.tsx` 的 `DropdownRow` 选中态 `rgba(168,85,247,0.10)` + 左边框 `rgba(168,85,247,0.6)`。它在 `surface-tone-dark` 容器内，**不能**改引 `--semantic-purple-*`（暗岛未覆盖）；要么给暗岛补这三件套，要么按合法例外加注释 | P3 |
| open | GenSweepLoader 靛蓝流光 | `components/ui/GenSweepLoader.tsx` 的底色与流光用 `rgba(129,140,248,…)` / `rgba(165,180,252,…)`。它落在视觉创作画布上（画布底固定 `#1e1e1e`），改引 `--semantic-indigo-*` 会在浅色档取到深靛压深底；同上，属合法例外，缺的是注释不是 token | P3 |
| done | 注释误导 | `lib/tileAccent.ts` 已补【管辖范围】段：写明只约束品类色带、GUARDED 覆盖面、语义色槽除外 | - |
| by-design | 不做全站去紫 | 语义色槽的紫是设计的一部分，不是漏网 | - |
| by-design | 不扩 GUARDED | 在上面三条手写紫收敛完之前扩大 `GUARDED`，会一次红出大量与色带无关的命中，且没有对应收益 | - |

**修法陷阱（比缺口本身更容易翻车）**：这三处都在**固定暗底表面**上——`SelectionActionPopover` 带 `surface-tone-dark`，`DropdownRow` 在 `surface-tone-dark` 容器内，`GenSweepLoader` 落在硬编码 `#1e1e1e` 的画布上。`.surface-tone-dark` 暗岛覆盖了 `--accent-fg-violet` / `--accent-fg-violet-strong` / `--overlay-panel-solid` / `--semantic-indigo-text`，**但没有覆盖 `--semantic-purple-text/soft/border`**。所以「把字面量换成 `--semantic-purple-*`」这条看似正确的修法，会在浅色档取到 `#6b21a8` / `rgba(107,33,168,.24)` 深紫压深底 —— 正是 `tokens.css` 暗岛注释里警告的那种反向翻车。**动手前先确认：目标 token 在暗岛里被覆盖了吗？** 没覆盖就先补暗岛，或按合法例外留字面量 + 注释。

**踩坑记录**：2026-08-23 做首页设计稿时，我照色带把知识库划词浮层画成橄榄绿，而真实代码是紫的，据此判断「代码违规 229 处」并上报。核对后发现两个错——数字只统计了 4 个字面值、漏了守卫真正的判据（真实是 2129 处），结论也错了（分域不是违规）。**教训：断言某处违反某条规则前，先读那条规则的守卫覆盖了哪些路径，再看被判对象是否在那个范围内。** 这正是 `predicate-and-wiring-discipline.md` 形状 7「守卫自己没接上线」的镜像——那条说守卫漏掉了该守的文件，这次是我把守卫没管的文件当成了它该管的。

## 导航管理：全员导航总览 + dnd-kit 编辑器（2026-09-05）

来源：删 MAP 左侧「模型」菜单时补的三件事——「全部用户」总览、按人重置、编辑器换 dnd-kit。交付时声明的边界：

| 边界 | 影响 | 状态 |
|------|------|------|
| 总览里「已下线」判定用的是当前管理员自己的菜单目录（按其权限过滤） | 非 root 且权限不全的管理员，会把自己看不到的合法菜单误标成虚线红框 | 待办：后端返回目录全集给总览用，或总览只对 root / super 开放 |
| 总览展示的是用户保存的原始 navOrder，不复演侧栏的「新菜单自动追加」 | 行里少的那几项不是被隐藏了，而是用户没动过它们、侧栏会自动补到末尾 | 已在页面说明文案里点明；如需「所见即侧栏」需把 AppShell 的追加逻辑抽成共享函数 |
| 新增的两个接口没有 xUnit 用例，只做了 CDS 部署后的接口冒烟 | 回归靠人工 | 待办：补 `DefaultNavConfigController` 的集成测试（列表排序 + 单人重置不波及他人） |
| 候选池条目拖进导航条时没有让位动画，只有插入标记 | 体验弱于导航内部排序 | 可选：把候选池也纳入 SortableContext 做跨容器排序 |

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 治理清单（按使用强度 + 破损度排序）

| 优先级 | 页面 | 路由 | 状态 |
|--------|------|------|------|
| P0 | 知识库列表工具栏（统计/发送到/接入AI → ⋯，新建 → FAB） | `/document-store` | 已落地（本次） |
