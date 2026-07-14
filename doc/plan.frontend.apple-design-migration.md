# plan.frontend.apple-design-migration

> Apple 设计系统双轨迁移的**活状态看板(SSOT)**。任何时刻打开这一屏,30 秒答出:现在到哪、卡在哪、下一步、凭什么算过。
> 遵守 `.claude/rules/living-status-board.md` / `parallel-workstreams.md` / `real-visual-acceptance.md`。
> 关联:`doc/plan.frontend.mobile-adaptation.md`(移动适配前序)、`.claude/rules/admin-dual-theme.md`(硬编码棘轮)、`report-design-system.md`(刊系纸面例外)。

---

**最后更新**:2026-07-14 · 3 个品牌决策已拍板(见 §5) · **距离可发布**:Phase 0 手机底座开工中(先做底座0a appStore.tsx 双皮肤破口)。

**已拍板决策(2026-07-14)**:Q1 PC 强调色**统一改 iOS 系统蓝**(gold-gradient 全收 systemBlue);Q2 --font-display 后台内页回 SF、landing/hero 保留 Space Grotesk 作品牌例外;Q3 移动端暗底**一律强制纯黑 #000**(含 MobileHomePage/Editor 的微灰 #08090a/#101014)。

## 状态看板

| 阶段 | 进度% | 状态 | 当前 blocker | 下一步 | 验收证据 |
|---|---|---|---|---|---|
| **手机·底座0a** appStore.tsx 双皮肤破口 | 90 | 已部署 | 无 | 预览域名双主题目视验收(移动百宝箱 shelf/pill/轮播) | tsc+lint 绿;预览见文末 |
| **手机·底座0b** MobileBottomSheet P0 | 90 | 已部署 | 无 | 预览域名浅色下开任意"更多"弹层验收(sheet 不再深底) | tsc+lint 绿;预览见文末 |
| **手机·底座1** 补 4 缺失原语 + token | 85 | 已部署 | 无 | 在 MobileHomePage 消费后一并双主题验收(原语纯新增,暂无独立入口) | tsc+lint 绿 |
| **手机·底座2** 玻璃 TabBar + chrome 收尾 | 0 | 未开始 | 无 | MobileTabBar 金色→AS_COLOR.blue、字号圆角收敛、T 对象派生 AS token;Fab/OverflowMenu/CompatGate/Segmented 补双皮肤 | 待办 |
| **手机·页面** MobileAssetsPage(P0 白底浮暗卡) | 90 | 已部署 | 无 | 预览域名浅色下开"资产"页验收(卡片/tab/占位不再隐形) | tsc+lint+ratchet 绿;预览见文末 |
| **手机·页面** MobileHomePage 重构 Today(主入口) | 0 | 未开始 | 依赖底座1 原语先就位 | 删自研 LIGHT/DARK_SKIN(:74-105),头部换 AppStoreHero,补齐 Today 区块 | 待办 |
| **手机·页面** MobileToolboxView 魔数收敛 | 0 | 未开始 | 无 | 字号 28/16/12/10→AS_TYPE;shared.ts accent→AS_COLOR iOS 色 | 待办 |
| **手机·页面** MobileProfilePage 双皮肤补全 | 0 | 未开始 | 无 | 消除 active:bg-white/[0.03](:127/:161)、INFRA_COLORS(:21)→AS_COLOR | 待办 |
| **手机·页面** MobileNotificationsPage | 0 | 未开始 | 无 | notificationTone 四档(:16-21)→AS_COLOR 语义色 | 待办 |
| **手机·页面** MobileVisualAgentEditor token 迁移 | 0 | 未开始 | 无 | 引 hook,背景 #101014(:588)→AS_COLOR.bg,强调 rgba(120,120,255)→blue | 待办 |
| **PC·底座** tokens.css 新增 --ios-* 语义层 | 0 | 未开始 | 无 | :root + [data-theme=light] 双块各加 --ios-blue/green/... (值取 AS_COLOR/AS_COLOR_LIGHT) | 待办 |
| **PC·底座** --font-body 改 SF-first | 0 | 未开始 | 无(landing 保留 Space Grotesk 例外) | tokens.css:78 SF 打头;base.css 加 body{font-family:var(--font-body)} | 待办 |
| **PC·底座** focus/accent 对齐 iOS 蓝/绿 | 0 | 未开始 | 无(已定:统一 iOS 蓝) | --border-focus(:22)/--accent-green(:56)→--ios-* | 待办 |
| **PC·底座** canvas 状态色对齐 iOS | 0 | 未开始 | 无 | :102-118 --canvas-state-* 及衍生 rgba→--ios-* | 待办 |
| **PC·底座** 暗色补齐 status token | 0 | 未开始 | 无 | :root 补 --status-done/going/idle(现仅 :214-222 浅色有) | 待办 |
| **PC·底座** design/* 原语色/圆角统一 | 0 | 未开始 | 无(已定:统一 iOS 蓝) | Button/PageHeader/SegmentedTabs active 切系统蓝;KpiCard→iOS 色;补 radius token | 待办 |
| **PC·清扫** 硬编码 hit-list(底座→高频页) | 0 | 未开始 | library/md-to-ppt 深色 hex 需先确权是否 data-theme 钉死 | 先清 AppShell(:931/:998/:1112/:1134)+design/*,再 CdsAgentPage(178)→ChangelogPage→InfraServices | 待办 |

进度口诀:blocker 状态翻转或功能代码净增才算进展;文档/脚本数量不计(`blocked-state-circuit-breaker.md`)。

---

## 1. 执行摘要

两轨并行,可 worktree 隔离(`parallel-workstreams.md`):

- **手机轨(主力)**:把移动页从"各写各的自研皮肤"整体迁到 **App Store Today 加厚范式**。SSOT = `lib/appStoreTokens.ts` + `hooks/useAppStoreColors.ts` + `components/mobile/appStore.tsx`。当前**唯一**真正对接 SSOT 的移动页是 `MobileToolboxView`(已基本对齐,仅魔数待收敛);主入口 `MobileHomePage` 是完全自研双皮肤,零对接。
- **PC 轨(只统一底座)**:视觉布局/盒模型/结构**一律不动**,只做 `tokens.css` 的 **SF 字体栈 + iOS 系统色语义层**,让 PC 与移动端共用一套字体与色基因;硬编码按 `themeHardcodeRatchet` 基线从底座层向高频页清扫。PC 轨**无 P0 阻塞**(双皮肤未破)。

**最高优先级 P0 破口**:① `MobileBottomSheet` 硬钉 `#1c1c1e` 无浅色(高频共享底座,承载全站 OverflowMenu);② `MobileAssetsPage` 整页无 useDataTheme(白底浮暗卡,底部 Tab 一级入口);③ `AppStoreHero` 硬钉白字(Today 首屏主入口)。

## 2. 手机轨

**目标**:全部移动页走 useAppStoreColors 双皮肤 + AS_TYPE 9 档字号 + AS_FONT_FAMILY(SF) + iOS 系统色 + AS_SPACE 圆角三档(22/18/12/999),消除自研皮肤与硬编码色板,浅色不再白底浮暗卡。

**底座先行(页面迁移的前置依赖,严守顺序)**:
1. **P0 双皮肤破口** — appStore.tsx 的 Hero/Pill/Shelf/Carousel dot 从直接 import `AS_COLOR` 改 `const C = useAppStoreColors()`(对齐已正确的 SectionHeader/RankedList/PillLabel)。
2. **P0 共享 Sheet** — MobileBottomSheet 引 hook 双色(连带治好全站"更多"sheet 浅色破皮)。
3. **合并孪生组件** — AppStorePill 并入已双皮肤的 AppStorePillLabel,消除漂移。
4. **补缺失核心原语** — 新增 `AppStoreGrid`(智能体宫格)/`AppStoreChips`(分类横滑)/`AppStoreResumeCard`(继续上次,源 `home_recent_opens`)/`AppStoreTipCard`(每日小技巧);同步 token 增 gridIconSize/gridGap/chipHeight。
5. **玻璃 TabBar 纳入基础层** — 激活态琥珀金→AS_COLOR.blue,字号/圆角收敛,T 对象派生 AS token。
6. **chrome 收尾** — Fab/OverflowMenu/CompatGate/Segmented 补双皮肤;token 打磨(真 9 档)。

**页面 backlog(优先级序)**:
| # | 页面 | 优先 | 工作量 | 为什么 |
|---|---|---|---|---|
| 1 | MobileAssetsPage 双皮肤 | P0 | S | 整页无 useDataTheme,白底浮暗卡,一级入口高频 |
| 2 | MobileHomePage 重构 Today | P0 | L | 主入口,自研皮肤零对接 SSOT,不切则所有 Today 区块无处落(依赖底座1) |
| 3 | MobileToolboxView 魔数收敛 | P1 | S | 唯一已对齐页,仅字号/accent 待收敛 |
| 4 | MobileProfilePage 双皮肤补全 | P1 | M | 一级入口,残留硬编码 + 未接设计系统 |
| 5 | MobileNotificationsPage | P1 | S | notificationTone 四档硬编码 |
| 6 | MobileVisualAgentEditor token 迁移 | P1 | M | 全高达标但零对接,light 全暗 |
| 7 | DailyPostPage(**不迁移,仅登记**) | P3 | S | 米多早报刊系纸面页,`report-design-system` 合法 grandfather 例外,勿误改 |

## 3. PC 底座统一轨

**目标**:只换底座(token / SF 字体 / iOS 系统色 / design/* 原语色与圆角来源),布局零改动,PC 与移动端共用色/字基因。

**backlog(优先级序)**:
1. **P1** tokens.css 新增 `--ios-*` 系统色语义层(CSS 层 SSOT,值取 AS_COLOR/AS_COLOR_LIGHT) — 纯新增,是其余项的引用来源。
2. **P1** `--font-body` 改 SF-first(现 Inter 打头 :78) + base.css 全局 body 兜底。
3. **P1** focus/accent 对齐 iOS 蓝/绿(--border-focus indigo :22、--accent-green #7cfc00 :56)。
4. **P1** canvas 状态色 → iOS(Tailwind #3b82f6/... :102-118 + 衍生 border/edge rgba 一并改)。
5. **P2** :root 暗色补齐 --status-done/going/idle(现仅浅色 :214-222)。
6. **P2** design/* 原语色/圆角统一(Button/PageHeader/SegmentedTabs active + KpiCard + radius token)。
7. **P2** 硬编码清扫 hit-list — 先底座层 AppShell + design/*,再按计数 CdsAgentPage(178)→ChangelogPage(73)→InfraServices(70)→视觉/知识库族→海报族;library/md-to-ppt 先确权是否纸面钉死。

## 4. 风险

- MobileHomePage 是 L 级主入口重构:**必须严守"底座1 原语先就位"**,否则半成品塌布局/双皮肤破;worktree 隔离防污染 main。
- `themeHardcodeRatchet` 只减不增:每文件改完即跑棘轮,清扫使基线过期时 `UPDATE_THEME_BASELINE=1` 重写并 PR 说明,禁无说明上调基线。
- MobileTabBar 已有合法皮肤对象双写,改强调色/字号别误删双写结构。
- PC canvas 衍生 rgba 与 base 色耦合,base+衍生一并改并两主题核对三画布。
- library/* 深色 hex 盲目按计数清扫会破坏纸面 grandfather 例外,清扫前先 grep 确权。
- 跨轨共享文件 `appStoreTokens.ts`:PC 轨只读取值、移动轨才改结构,避免 scope 越界。
- gold-gradient / Space Grotesk 未拍板前先改再回退返工成本高 → 见 §5,先确认再动。

## 5. 待用户拍板(gate 开工的品牌决策)

- **Q1 gold-gradient 靛紫强调色**:是刻意的 MAP 品牌色,还是应统一归到 iOS systemBlue?(Button primary / PageHeader active / SegmentedTabs active 全依赖)→ **gate 住 PC 底座 focus/accent 与 design/* 两项**。
- **Q2 --font-display(Space Grotesk)标题字体**:后台内页回归 SF Pro Display,还是保留 Space Grotesk 作 landing/hero 品牌例外?(建议:后台内页 SF、landing 保留)
- **Q3 移动端暗底纯黑**:App Store 规范纯黑 #000,现 MobileHomePage/Editor 用微灰 #08090a/#101014 — 移动端暗底一律强制纯黑,还是编辑器类可留微灰?
- 次要:AppStoreGrid icon 尺寸(60/62)与列数(3/4);ResumeCard 数据源 `home_recent_opens` 字段是否够;海报族清扫的"产物纸面 vs chrome"边界。

**手机轨底座0/底座1 与 MobileAssetsPage 无 blocker,不依赖上述决策,可立即开工。** PC 轨的 focus/accent 与 design/* 需先定 Q1。

## 6. 预览

底座0/底座1/MobileAssetsPage(已部署,待双主题目视验收,需 <768px 移动视口):
- 移动百宝箱(AppStoreShelf/Pill/轮播小点 + "更多"弹层): https://apple-design-audit-m5r28u-claude-prd-agent.miduo.org/ai-toolbox
- 移动资产页(P0 白底浮暗卡修复,浅色下卡片/tab/占位应清晰可见): https://apple-design-audit-m5r28u-claude-prd-agent.miduo.org/my-assets
- 浅色下开任意"更多"OverflowMenu,确认 sheet 不再深底浮暗。
- 底座1 的 4 个原语纯新增、暂无独立入口,待 MobileHomePage 重构消费后随首页一并验收。
