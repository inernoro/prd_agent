# 页面新手指引（小技巧）维护规则

> 每个大型智能体页面都有自己的**本页完整新手指引**（约 6-15 步 Tour，能从列表「贯通」进编辑器走完整生命周期）。入口是右上角常驻、带文字标签的 pill；用户进入任一有教程且**没走完**的页面会**自动开讲**，走完最后一步才算过——强制人人过一遍。本规则保证：页面 UI 变了，指引和锚点必须同步更新，不留断点。

---

## 〇、触达机制（2026-06-02 重做，最高优先）

- **入口位置**：右上角常驻 pill（文字「本页教程 / 新手指引」），始终可见、不可贴边隐藏。**禁止**改回右下角匿名图标（用户原话：像个小广告，没人点）。
- **移动端例外（2026-06-22 用户要求）**：手机端（`<768px`）**隐藏** TabBar/PageHeader 内嵌的教程 pill，把顶部空间让给页面操作（控制条过载治理）。教程入口改由「我的 → 学习中心」（`/learning-center`）承载；新人未走完的本页 `*-page-guide` 仍由 `SpotlightOverlay` 自动开讲（不依赖 pill）。即"桌面常驻 pill、手机收进学习中心 + 自动开讲"。
- **强制自动开讲**：`TipsDrawer` 有一个 effect——进入任意路由，若存在 `actionUrl` 匹配当前页、且 `sourceId` 以 `-page-guide` 结尾的 tip 还在 `tips` 里（后端已过滤掉「已学会」的 → 还在 = 没走完），就用 `writeSpotlightPayload` 自动开讲一次。本 session 每条只自动弹一次（`sessionStorage` 的 `tipsAutoStartedGuides`），跨 session 未走完会再弹，直到 `SpotlightOverlay` 末步「完成」`markLearned`。**新增页面教程时务必用 `*-page-guide` 后缀的 sourceId，否则不会自动开讲。**
- **全局唯一挂载**：`<TipsDrawer/>` 与 `<SpotlightOverlay/>` 挂在 **App 根**（`src/app/App.tsx`，Router 内、Routes 外），跨任意路由（含 shell→全屏编辑器）**不卸载**。这样本页教程的 `NavigateTo` / 自动点击「新建」进编辑器的步骤不会因路由切换丢 state。**禁止**再在 `AppShell` 或某个页面里单独挂这两个组件（会重复实例 + 跨页丢 state）。

## 一、SSOT 与触发范围

- **唯一数据源**：`prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs` 的 `BuildDefaultTips(now)`。每个页面一条 `*-page-guide` 的 `card` 类型 seed，`DisplayOrder = 0`（保证该页打开抽屉时本页教程排第一）。
- **锚点**：页面上的 `data-tour-id="..."` 属性。Tour 每一步的 `Selector` 必须能在对应页面 `document.querySelector` 命中。
- 已落地的页面教程（截至 2026-06-02）：
  | 页面 | route | seed id | 步数 |
  |------|-------|---------|------|
  | 网页托管 | `/web-pages` | `webpages-page-guide` | 14 |
  | 视觉创作 | `/visual-agent` | `visual-page-guide` | 11（+ 进编辑器步骤见下） |
  | 知识库 | `/document-store` | `document-store-page-guide` | 8 |
  | 文学创作 | `/literary-agent` | `literary-page-guide` | 8（+ 进编辑器步骤见下） |
  | 海鲜市场 | `/marketplace` | `marketplace-page-guide` | 6 |
  | 智识殿堂 | `/library` | `library-landing-page-guide` | 7 |
  | 作品广场 | `/showcase` | `showcase-page-guide` | 6 |
  | 缺陷管理 | `/defect-agent` | `defect-page-guide` | 8（贯通:浏览→打开提交面板→填写→提交） |
  | PR 审查 | `/pr-review` | `pr-review-page-guide` | 4 |
  | 涌现探索器 | `/emergence` | `emergence-page-guide` | 4 |
  | 工作流 | `/workflow-agent` | `workflow-page-guide` | 4 |
  | 开放接口 | `/open-platform`（tab=open-api） | `open-api-page-guide` | 6（最简生命周期:签发→配置→调用→排障；锚点 open-api-root/stats/list 常驻；首步 NavigateTo 带 `?tab=open-api` 切到该 tab） |
  | 视觉创作·编辑器 | `/visual-agent/:id` | `visual-editor-page-guide` | 3 |
  | 文学创作·编辑器 | `/literary-agent/:id` | `literary-editor-page-guide` | 4 |

  周报（`/report-agent`）按用户要求**不做**本页教程。

- **贯通（进编辑器）**：列表页教程不能只在列表表面打转。对有编辑器的应用（视觉/文学），最后几步应**自动点「新建」进入编辑器**再高亮编辑器内的核心步骤。靠 `SpotlightOverlay` 的「下一步」会先自动点击当前 `button/a/role=button` 元素再前进（见 `SpotlightOverlay.tsx`），所以「新建」锚点放 `role=button`，点击后页面 `navigate` 到 `/{agent}/:id`，根挂载的 overlay 持续 poll 到编辑器锚点继续讲。编辑器锚点用 `*-editor-*` 前缀。

## 二、强制更新钩子（改页面就得改教程）

当你改动上表任一页面（重排布局、删按钮、改 `data-tour-id`、加核心功能）时，**同一个 PR 内必须**：

1. **锚点对账**：grep 该页所有 `data-tour-id`，逐一比对对应 `*-page-guide` 的每个 `Selector`。删了锚点 → 删/改对应步骤；移了锚点 → 步骤 Body 文案同步；加了核心功能 → 新增锚点 + 步骤。
2. **常驻校验**：Tour 锚点必须是**页面常驻元素**（含空状态占位卡），不能指向 modal/dropdown 里只在交互后出现的元素，否则新用户（空数据）跑到那步会卡 10 秒超时。详情页内的按钮（如知识库的「上传/发布」）用列表页常驻锚点承载，靠 Body 文案指引。
3. **自检**：`grep -o 'data-tour-id="[^"]*"' <page>` 的集合 ⊇ 该页教程所有 `Selector` 引用集合。

## 三、新增页面教程的标准流程

1. 给页面加 ~8-15 个 `data-tour-id`（常驻元素优先；自定义组件如 `TabBar`/`GlassCard` **不转发** `data-*`，需包一层 `div`/`span` 或锚到原生 DOM；`design/Button` 会转发，可直接加）。
2. 在 `BuildDefaultTips` 新增一条 `*-page-guide` seed：`kind="card"`、`tier="basic"`、`DisplayOrder=0`、`actionUrl` 指向该 route、第 1 步带 `NavigateTo`。
3. 步数控制在 8-15（少于 6 步意义不大——用户本来就能点）。
4. 更新本规则上表 + 跑视觉验收。

## 四、为什么用 seed-in-code 而非手动 POST

`*-page-guide` 写进 `BuildDefaultTips` 后随代码版本走、对全体用户自动可见、不依赖管理员手动 POST，也天然满足「功能更新 → 教程更新」走同一条 PR 审查。临时/活动类 tip 才走 `POST /api/admin/daily-tips`（见 `createzzdemo` 技能）。

## 五、统一升级（2026-06-04，本节为现行机制最高优先）

把整套教程系统做了一次统一,以下为**现行行为**,与上面旧描述冲突处以本节为准:

### 5.1 三类 tip（优先级,治「只是更新却重弹新手」）
- **新手教程 onboarding**：`tier=basic` + `*-page-guide`。每人一次（学会写 `Version=int.MaxValue`,永不再弹）。进页未走完自动开讲一次/session。**计入头像掌握度**。
- **更新教程 update**：`tier=advanced` + `sourceId=*-update-YYYYwNN`。发布窗口=本周（`StartAt/EndAt`）；学会写真实 Version,功能再更新升 Version → 再次提醒；**绝不动 `*-page-guide`,不重弹新手整套**。由 `tutorial-daily-maintain` 技能定时起草。
- **快捷任务 task**：其余带 `Steps` 的 seed（如 `defect-full-flow`）。
- 后端 `CategoryOf()` 按 sourceId 后缀分类;`GET /api/daily-tips/progress` 返回目录 + 掌握度（onboarding 计分母）。

### 5.2 选择面板(诉求 4/7)
点 pill：本页**只有一套**教程 → 直接开讲（`START_TUTORIAL_EVENT`）；**多套** → 弹「选择面板」(TipsDrawer 列表,每套显示步数/约时/状态 chip/「跟我做」「重看」「已会」)。不再是单卡轮播。

### 5.3 镂空可点(诉求 8)
`SpotlightOverlay` 用四块透明遮罩围住光圈、**中间留洞**,高亮目标可被用户**真实点击**「跟我做」,点中即推进；「下一步」按钮兜底。**不再**整屏拦截点击。

### 5.4 完成飞回动画(诉求 6)
教程末步「完成」→ 撒花 + `markLearned` + 一枚毕业帽从光圈**飞回右上角 pill**（`[data-tour-entry]`）,提醒以后从这里重看。

### 5.5 进度可见(诉求 11/12)
- 头像外圈 `AvatarProgressRing` = 已学/总 onboarding 教程,满环加毕业角标。
- 「学习中心」页 `/learning-center`（百宝箱 + 头像下拉入口）：分类列全部官方教程 + 一键跟我做/重看。
- markLearned 走乐观更新,环即时填。

### 5.6 加锚点:TabBar/PageHeader 自动注入 pill
`PageHeader`/`TabBar` 在有 `title`/`items`/`actions` 时**自动注入** `<TipsEntryButton/>`,pill 在「本页无教程」时自隐。⇒ 用这两个组件的页面**无需手嵌** pill;自定义头部的页面才需手嵌。

### 5.7 自动弹出严格按页（2026-06-11,治「无教程页面弹出全部教程」）
- **没有教程的页面绝不自动弹任何东西**。自动出现只剩两类,且都限定在「本页有教程」的页面:
  1. 新人没走完本页 `*-page-guide` → Spotlight 自动开讲(每 session 一次,机制不变);
  2. 本页功能有更新(本页存在未学会的 `*-update-*` / `feature-release` tip)→ 抽屉自动展开一次,**只显示本页教程列表**。
- 决策唯一入口:`pageGuideMatch.ts` 的 `pickAutoOpenUpdateTip(pageTips, opened)`,入参必须是 `filterPageTips` 按当前页过滤后的子集 —— 结构性保证不会在 A 页弹 B 页教程;禁止再用全量 tips 做自动弹出判定,禁止自动 `setShowAllPages(true)`。
- **「管理员定向推送(isTargeted)自动弹抽屉」已删除**:推送管理后台 2026-06-04 已下线,该路径只剩脏数据来源 —— Track 端点会给「看过一眼」的用户补 Delivery 统计记录,`/visible` 旧逻辑 `isTargeted = TargetUserId==userId || mine != null` 把统计记录误判成"被推送",导致任何浏览过的教程永久变成"为你推送",并在无教程页面自动弹出"全部教程"面板(2026-06-11 用户反馈「莫名其妙弹出,像病毒一样」)。后端已改为仅认 `TargetUserId`,Delivery 仅作统计。
- 守卫测试:`prd-admin/src/components/daily-tips/__tests__/pageGuideMatch.test.ts` 的 `pickAutoOpenUpdateTip` 套件(无教程页恒 null / isTargeted 不参与决策)。

## 5.9 关闭体验三连(2026-06-11,本节为现行机制)

用户反馈:多步教程「每天弹一次很烦」+「关闭时飞回入口的动画看不见」。三处改动:

### 5.9.1 「我已学会」一键退出口(SpotlightOverlay)
- 多步教程气泡底部新增「我已学会」按钮(`steps.length>0 && payload.id` 才显示;单步「知道了」本身即确认,不重复加)。
- 点击 = `markLearned(payload.id)` + 飞回动画关闭。该页 `*-page-guide` 学会后不再自动开讲、入口不再脉冲(仍可手动重看)。给「觉得弹窗烦」的用户无需走完整套即可退出。

### 5.9.2 任何关闭都播「飞回入口」动画,半速(SpotlightOverlay)
- 飞回动画(毕业帽 → 右上角 `[data-tour-entry]` pill)从「仅完成末步触发」扩展到**所有关闭路径**:X / 点空白遮罩 / ESC / 我已学会 / 完成 / **单步 5s 自动淡出** / **autoClick 完成**(后两条 2026-06-12 补,治「单步 reminder 不交互静默消失、不提示入口」;autoClick 若已导航离开则 `flyBackToEntry` 取不到光圈静默跳过)。
- `FlyingToken` 时长 720ms → **1440ms(半速)**,解决「太快看不见」。统一走 `closeWithFlyBack()`(先 `flyBackToEntry()` 设 flyBack 再 `setDismissed`);`flyBackToEntry` 起点优先取当前光圈、退而取气泡卡片,取不到就不播(定位中/超时态无光圈时静默关闭)。
- 注意:纯关闭(X/空白/ESC)**只播动画不 markLearned**;只有「我已学会」「完成」才标记学会。

### 5.9.3 轻微提醒更新(`*-update-reminder`,第三类自动弹出)
- 新增一种「更新提醒」子类:`sourceId` 含 `-update-reminder`,`sourceType=update-reminder`,单步(无 `Steps`,靠 `TargetSelector` + `Title`/`Body`)。
- 进入对应页 → 由 `TipsDrawer` 专用 effect 走 **Spotlight 悬浮气泡**(不是抽屉),在功能位置弹一次轻提醒「这里更新了」;弹出当下即 `markLearned` → 不管用户取消还是「知道了」都不再显示(跨 session 永不再弹,服务端持久化)。
- 与 §5.7 第 2 类「周更新教程(`*-update-YYYYwNN`/`feature-release`)自动展开抽屉」互斥:`pickAutoOpenUpdateTip` 用 `isUpdateReminderTip` 把 reminder 排除出抽屉路径,避免同一条既弹抽屉又弹气泡。优先级低于本页 `*-page-guide` 强制开讲。
- 首例:`visual-agent-paste-update-reminder`(视觉创作首页可粘贴图片),锚 `[data-tour-id=visual-image-btn]`,`endAt=2026-09-01` 后新用户不再看到。
- **三条防重叠/防重复/防错页约束(2026-06-12,回应 PR #788 review)**:
  1. **同 session 不紧跟 page-guide 弹**:若本页 `*-page-guide` 在本 session 已自动开讲(`tipsAutoStartedGuides` 命中),reminder 当 session **跳过**——新人刚走完整套教程(里面已讲到该新功能),不再立刻弹气泡重复打断;留到下次进页再弹(Codex P2)。
  2. **占当天自动弹额度**:reminder 弹出当下即 `markLearned`,会把自己移出 `pageTips`,使抽屉自动展开 effect 的「有未学会 reminder 就跳过」守卫失效;若本页同时有未学会的周更新教程,抽屉会在气泡上层再自动展开。故 reminder 触发时调 `markAutoOpenedToday()` 占掉日额度,抽屉本 session 不再自动弹(Bugbot Medium)。
  3. **精确路由门(非子路由前缀)**:reminder 是非 page-guide,`filterPageTips` 会把它前缀匹配到**子路由**(如 `/visual-agent/:id` 编辑器),但锚点(`visual-image-btn`)只在列表页存在。故 reminder 弹出前必须 `location.pathname === routePathOf(actionUrl)`(精确等于,非前缀),阻止「在子路由弹空目标 + `markLearned` 永久消费」(Codex P2)。**注意不要在此再 `document.querySelector(锚点)` 当门**:列表页 Suspense 懒加载,effect 首跑时锚点可能未挂,查不到就 return 且 deps 不含 DOM 就绪信号会导致 reminder **永不自动弹**(Bugbot High)。锚点就绪交给 `SpotlightOverlay` 自身轮询(≤10s + 「正在定位」)兜底——精确路由已保证锚点终会出现,不会误消费。
  4. **抽屉抑制也要判精确路由**:抽屉自动展开 effect 的「本页有未学会 reminder 就跳过」守卫必须带 `location.pathname === routePathOf(t.actionUrl)`,否则子路由(`/visual-agent/:id`)上那条**其实不会弹**的 reminder 会误抑制子路由的周更新教程抽屉(Bugbot Medium)。
- 判定函数 SSOT:`pageGuideMatch.ts` 的 `isUpdateReminderTip`;守卫测试见 `pageGuideMatch.test.ts` 的「isUpdateReminderTip / 轻微提醒更新走 Spotlight 气泡而非抽屉」套件。

## 六、相关

- `.claude/skills/createzzdemo/SKILL.md` — 生成单条教程小书
- `.claude/skills/tutorial-daily-maintain/SKILL.md` — 教程每日维护（漂移检测 + 更新提醒 + 验收归档）
- `prd-admin/src/components/daily-tips/TipsDrawer.tsx` — 右上角「选择面板」列表
- `prd-admin/src/components/daily-tips/TipsEntryButton.tsx` — 页头 pill 入口（`data-tour-entry`）
- `prd-admin/src/components/daily-tips/SpotlightOverlay.tsx` — 镂空高亮 + 逐步引导 + 飞回动画
- `prd-admin/src/components/daily-tips/AvatarProgressRing.tsx` — 头像掌握度进度环
- `prd-admin/src/pages/learning-center/LearningCenterPage.tsx` — 学习中心
- `DailyTipsController.Progress` / `CategoryOf` — 进度端点 + 分类口径
- CLAUDE.md 规则 #9 — `data-tour-id` 锚点命名规范
