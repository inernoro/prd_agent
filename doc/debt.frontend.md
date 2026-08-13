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
| P1 | 模型中心（4 处 flex-wrap） | `/mds` | 待办 |
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

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 治理清单（按使用强度 + 破损度排序）

| 优先级 | 页面 | 路由 | 状态 |
|--------|------|------|------|
| P0 | 知识库列表工具栏（统计/发送到/接入AI → ⋯，新建 → FAB） | `/document-store` | 已落地（本次） |
