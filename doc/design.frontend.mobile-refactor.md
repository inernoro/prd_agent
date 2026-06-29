# 手机端整体重构调研 · 设计

> **版本**：v1.0 | **日期**：2026-06-22 | **状态**：调研中（待获取队友最新代码后复核）

## 一、管理摘要（30 秒看懂）

本系统已经有一套相当完整的手机端基建：底部 5 Tab 导航、抽屉、安全区适配、`MobileCompatGate`（按页声明 full/limited/pc-only）、以及一个已经做成「App Store 今日」风格的移动首页。问题不在「没有手机端」，而在「首页做完了，首页点出去的关联页面没跟上」——用户从首页/底部导航点进去的几个核心目的地，要么卡在加载动画、要么把桌面多栏布局原样塞进手机，控制条堆三层、内容被挤到角落。

本次调研用真机视口（390×844）对 16 个常用页面做了视觉取证，并查了行为聚合接口的真实使用强度。结论：

- **真实使用强度最高的是「知识库（document-store）」**，远超其它（占被记录写操作的约 93%），其次是视觉创作、缺陷管理。
- **底部导航 4 个目的地里有 2 个在手机端是坏的**：`浏览(/ai-toolbox)` 反复卡在 MAP 加载动画进不去内容，`资产(/my-assets)` 近乎空白。这是最该先修的。
- 视觉创作（visual-agent）本次**不在范围内**（队友正在做），其余按「使用强度 × 当前手机端破损度」排了三个改造波次。
- 不需要重造轮子：先复用已有的 `MobileCompatGate` / `mobile-first-density` 纪律 / App Store 组件，把首页那套「内容优先、控制条收纳」的做法平移到关联页即可。

下一步：等队友把视觉创作那条线收口、我方拉到最新代码后，按第六节波次开工，先啃 W1（知识库 + 两个坏掉的 Tab 目的地）。

---

## 二、调研方法与数据来源

| 维度 | 来源 | 可信度 |
|------|------|--------|
| 页面清单 | `prd-admin/src/app/navRegistry.tsx`（路由 SSOT，约 45 个用户可见路由） | 高（代码权威） |
| 当前手机端声明 | `prd-admin/src/lib/mobileCompatibility.ts` 的 `MOBILE_COMPAT_REGISTRY` | 高（人工维护的判定） |
| 真实使用强度 | 行为聚合接口 `GET /api/team-activity/stats`（真实数据，AI 超级密钥模拟 inernoro） | 中（见下方局限） |
| 当前手机端实况 | Playwright + Chromium 真机视口 390×844，对 16 个页面截图取证 | 高（眼见为实） |

**数据局限（必须诚实标注）**：

1. 可访问的运行实例是分支预览（共享同一套 Mongo），**流量偏低**（30 天仅 985 条写操作、3 名活跃用户），定量排名信号较稀。
2. 最适合「人类进入页面强度」的两个聚合端点本次取不到：`experience-map`（按 API 调用量铺热力图）持续返回 401（重鉴权/重聚合超时，并非权限缺失——`team-activity.read` 已持有），`insights`（停留/秒退信号）返回 500。故使用强度主要由 `stats`（写操作分布）+ 导航结构 + 既有 compat 判定三者交叉得出，**不是精确 PV 排名**。
3. 截图取证基于队友的 `product-import-parsing` 分支预览，前端与 main 仅有小差异；**拿到我方最新代码后需对关键页复拍复核**。

> 行为聚合接口确实存在且是「人类进入页面程度」的正解（`behavior_events` 的 route-dwell + `apirequestlogs` 的 experience-map），但当前实例上一半端点不可用、流量稀疏。结论以视觉实况为主、聚合数据为辅。

---

## 三、真实使用强度（聚合数据）

`stats` 按写操作模块分布（30 天，全量）：

| 模块 | 写操作数 | 占比 | 备注 |
|------|---------|------|------|
| 知识库 document-store | 920 | ~93% | 上传/删除/更新/发布文档为主，是真正的高频主场 |
| 视觉创作 visual-agent | 38 | ~4% | 生图（本次不改） |
| 缺陷管理 defect-agent | 25 | ~3% | 建/提缺陷 |
| 网页托管 web-pages | 2 | <1% | |

热门动作前列：删除文档(370)、上传文档(334)、更新文档内容(94)、发布文档(80)、发起生图(36)、创建知识库(23)。

**解读**：写操作高度集中在知识库；但「写」不等于「看」，浏览类页面（首页、百宝箱、智识殿堂、海鲜市场、缺陷列表、周报）的进入频次靠 experience-map 才看得全，而那个端点本次不可用。因此排序时把「知识库」放最高优先没有争议，其余按「底部导航可达性 + 既有 compat 判定」补位。

---

## 四、现有手机端基建盘点（先用、别重造）

| 资产 | 位置 | 现状 |
|------|------|------|
| 底部 5 Tab 导航 | `components/ui/MobileTabBar.tsx` | 首页/浏览/+(扇形 Agent)/资产/我的，安全区适配，动效完整 |
| 抽屉菜单 | `components/ui/MobileDrawer.tsx` | AppShell 在 `isMobile` 时挂载，汉堡→全量导航 |
| 兼容性门 | `components/MobileCompatGate.tsx` + `lib/mobileCompatibility.ts` | 按路由声明 full/limited/pc-only，limited 顶黄条、pc-only 弹「建议 PC」 |
| 移动首页 | `pages/MobileHomePage.tsx` | App Store「今日」风：Hero/海报轮播/智能体横滑/工具榜单/统计/通知/动态 |
| App Store 组件库 | `components/mobile/appStore/*` + `lib/appStoreTokens.ts` | Hero/Carousel/Section/Shelf/RankedList，可直接复用到关联页 |
| 移动专属页 | `MobileProfilePage` / `MobileNotificationsPage` / `MobileAssetsPage` | 通知页质量好，可作范式 |
| 密度纪律 | `.claude/rules/mobile-first-density.md` | `--mobile-padding`、`useIsMobile()`、GlassCard 嵌套自动去 chrome、「进内容前≤1 条控制条」「内容占首屏≥60%」 |
| 审计工具 | `pages/_dev/MobileAuditPage.tsx`（`/_dev/mobile-audit`） | 375 视口批量 iframe 扫黑屏/报错/超时，重构期回归用 |
| AppShell 移动壳 | `layouts/AppShell.tsx` | 移动顶栏+汉堡、底部 TabBar、CompatGate、`--mobile-*` 安全区 padding 都已就位 |

**结论**：外壳（chrome）层已经合格——截图里每个页面的顶栏、底部 Tab、安全区都正常。**缺口在每个页面自己的内容层**：把桌面布局塞进手机时没有按密度纪律收纳。

---

## 五、当前手机端实况（视觉取证）

390×844 真机视口逐页核验。分级：done=已是移动范式 / cramped=能用但挤 / broken=进不去或空白。

| 页面 | 路由 | compat 声明 | 实况 | 主要问题 |
|------|------|------|------|---------|
| 首页 | `/` | full | **done** | App Store 风，已完成（本分支主题） |
| 通知 | `/notifications` | full | **done** | 移动专属页，卡片列表干净 |
| 我的/设置 | `/profile` `/settings` | full | **done** | 头像卡+分栏，移动友好 |
| 知识库 | `/document-store` | full | **broken/cramped** | 顶部 7+ 控制按钮堆成 3 行；列表区长期「加载中…」未落地内容（最高使用强度，最该修） |
| AI 百宝箱 | `/ai-toolbox` | full | **broken** | 5.5s 与 ~16s 两次都卡在 MAP 启动动画进不去——而它是底部「浏览」Tab + 首页「全部」的目的地 |
| 我的资产 | `/my-assets` | full | **broken** | 近空白（textLen 136），底部「资产」Tab 目的地 |
| 缺陷管理 | `/defect-agent` | full | **cramped** | tab 渲染，列表区卡 MAP 加载；进得去但内容慢 |
| 周报 | `/report-agent` | full | **cramped** | 桌面多栏直接塞手机，右侧「团队周报列表」侧栏被截一半 |
| 模型中心 | `/mds` | limited | **cramped** | 顶部多排 chip + 列表区多个 MAP 骨架；已挂 PC 建议黄条 |
| 用户/团队 | `/users` | limited | **cramped** | 宽表挤；已挂「横向滑动」黄条 |
| 海鲜市场 | `/marketplace` | full | **cramped** | 渲染好，但顶部筛选 chip 堆多排，进内容前控制条过载 |
| 文学创作 | `/literary-agent` | full | **cramped** | 渲染正常（首访教程浮层覆盖），深度编辑仍建议 PC |
| 智识殿堂 | `/library` | full | rendered | 待复核细节 |
| 更新中心 | `/changelog` | full | rendered | 待复核细节 |
| 工作流 | `/workflow-agent` | pc-only | pc-only | 画布类，保持 pc-only |

**两类高频问题**（覆盖几乎所有 cramped 页）：

1. **控制条过载**：进到真正内容（列表/详情）前，顶部堆 2-3 排 tab/筛选/操作按钮，吃掉半屏（知识库、模型中心、海鲜市场、缺陷）。违反 `mobile-first-density` 的「进内容前≤1 条控制条」。
2. **桌面多栏未折叠**：左右分栏/主从布局原样塞进 390px，副栏被截断或与主栏抢宽（周报右侧栏、知识库主从）。违反 `content-fills-canvas`「主从布局产物占主导」。

外加一类**真·破损**：`/ai-toolbox`、`/my-assets` 这两个底部导航目的地在手机端进不去内容——优先级最高，因为它们是导航承诺的一级入口。

---

## 六、改造优先级波次（建议）

排序依据：使用强度（聚合）× 当前破损度（取证）× 导航可达性（是不是一级入口）。**视觉创作全程排除**。

### W1 — 先止血（一级入口坏掉 + 第一使用强度）
- `/ai-toolbox`（浏览 Tab + 首页「全部」目的地）：先定位为何卡 MAP——是懒加载 chunk、子 Suspense never-resolve，还是某个移动端必失败的 API。修到能落地内容，再套移动卡片栅格。
- `/my-assets`（资产 Tab）：补移动空状态 + 资源卡片栅格，消灭近空白。
- `/document-store`（知识库，第一使用强度）：顶部 7+ 按钮收纳成「1 条主控制条 + 溢出菜单」；主从列表在手机折叠为单列；补空/加载状态（`共 0 个` 时给空状态引导而非常驻 spinner）。

### W2 — 高频浏览页收纳控制条
- `/defect-agent`：列表区加载兜底 + 筛选收进 sheet；缺陷卡单列。
- `/report-agent`：右侧「团队周报列表」侧栏在手机折叠为 tab 或底部 sheet，主区单列铺满。
- `/marketplace`：筛选 chip 单行横滚（`overflow-x-auto`），卡片单/双列。
- `/library`、`/changelog`：按密度纪律复核并收口。

### W3 — limited 页收敛 + 范式沉淀
- `/mds`、`/users`、`/logs`：宽表保留「横向滑动」黄条，但把最关键 2-3 列做成手机卡片摘要；保留 PC 建议。
- 把 W1/W2 沉淀出的通用件（移动卡片列表、控制条收纳 sheet、空状态范式）提取到 `components/mobile/`，供后续页面直接套。
- 复核并更新 `MOBILE_COMPAT_REGISTRY`（把改造完成的页从 limited 升 full）。

### 保持 pc-only（不改）
`/visual-agent`（队友负责）、`/workflow-agent`、`/video-agent`、`/transcript-agent`、`/showcase` 等画布/大屏密集型，维持 pc-only + 「建议 PC」门槛。

---

## 七、每页改造要点（速查）

| 页面 | 核心动作 | 复用件 |
|------|---------|--------|
| ai-toolbox | 定位并修 MAP 卡死 → 移动卡片栅格 | App Store Shelf/RankedList |
| my-assets | 空状态 + 资源卡片栅格 | MobileNotificationsPage 范式 |
| document-store | 控制条收纳 + 主从折叠单列 + 空/加载兜底 | sheet 收纳 + GlassCard 嵌套去 chrome |
| defect-agent | 列表加载兜底 + 筛选进 sheet + 缺陷卡单列 | 同上 |
| report-agent | 团队侧栏折叠为 tab/sheet + 主区铺满 | `SplitToTabLayout`（已存在） |
| marketplace | 筛选 chip 单行横滚 + 卡片 1-2 列 | `--mobile-padding` |
| mds/users/logs | 关键列做卡片摘要 + 保留宽表横滑 + PC 建议 | MobileCompatGate |

---

## 八、已知边界与待办（拿到最新代码后复核）

- 本调研基于队友分支预览取证，**我方最新代码到手后需对 W1 三页复拍**，确认 ai-toolbox 卡死在最新代码是否仍现（区分「staging 慢」与「真破损」）。
- `experience-map` / `insights` 两个聚合端点本次不可用，**真·PV 排名未取到**；若需精确排序，需在可用实例上修复这两个端点或直接查 `behavior_events` route-dwell。建议把这条作为「数据侧待办」单独跟。
- 视觉创作线收口前不动 `/visual-agent` 任何代码，避免与队友冲突。
- 重构期用 `/_dev/mobile-audit` 做回归扫黑屏/报错。

---

## 关联

- `.claude/rules/mobile-first-density.md` — 手机端密度纪律（本次改造的执行标准）
- `.claude/rules/content-fills-canvas.md` — 内容填满画布（主从折叠依据）
- `.claude/rules/chief-designer-usability.md` — 好用四原则（收纳/不杜撰长链）
- `prd-admin/src/lib/mobileCompatibility.ts` — 兼容性 SSOT（改造完成后回写）
- `prd-admin/src/pages/_dev/MobileAuditPage.tsx` — 回归审计工具
