# 移动端控制条过载 治理台账 · 债务台账

> **版本**：v1.1 | **日期**：2026-07-12 | **状态**：进行中

## 2026-07-12 全站移动端混乱度审计（第二轮）

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

## 问题这一类（不是单点）

桌面工具栏的一排排按钮在手机上 `flex-wrap` 挤成三四行，把首屏吃光，"进内容前控制条 ≤1 条"（`.claude/rules/mobile-first-density.md`）被反复违反。典型：知识库列表、知识库详情（验收报告那种 4 行按钮）、缺陷、周报、模型中心、海鲜市场。

## 治理机制（一套机制治一类，复用而非重写）

只换外壳、不动动作逻辑（onClick 与桌面同一份）：

| 原语 | 位置 | 作用 |
|------|------|------|
| `MobileOverflowMenu` | `components/mobile/MobileOverflowMenu.tsx` | 次要按钮 → 手机端「⋯ 更多」→ 底部 Sheet |
| `MobileFab` | `components/mobile/MobileFab.tsx` | 主操作（新建/创建）→ 右下悬浮按钮 |
| `MobileSegmented` | `components/mobile/MobileSegmented.tsx` | 多 tab → 一条滑动段控 |
| `MobileBottomSheet` | `components/mobile/MobileBottomSheet.tsx` | Sheet 底座（createPortal，遵循 frontend-modal） |

落地范式：桌面 `{!isMobile && <原工具栏/>}` 原样保留；手机 `{isMobile && <主操作内联 + MobileOverflowMenu + MobileFab/>}`。桌面零改动。

## 治理清单（按使用强度 + 破损度排序）

| 优先级 | 页面 | 路由 | 状态 |
|--------|------|------|------|
| P0 | 知识库列表工具栏（统计/发送到/接入AI → ⋯，新建 → FAB） | `/document-store` | 已落地（本次） |
| P0 | 知识库详情工具栏（教程/同步/发布/关系图谱/统计/编辑…） | `/document-store` 详情 | 待办（部分在共享 `DocBrowser`，需谨慎） |
| P1 | 缺陷列表/详情工具栏 | `/defect-agent` | 待办 |
| P1 | 周报多视图工具栏（`report-agent/components/*` 多处 flex-wrap） | `/report-agent` | 待办 |
| P1 | 模型中心（4 处 flex-wrap） | `/mds` | 待办 |
| P2 | 用户/团队 | `/users` | 待办 |
| P2 | 海鲜市场筛选 chip 行 | `/marketplace` | 待办 |
| P2 | 知识库顶部 TabBar 换行（共享 `surface-nav-content` flex-wrap，影响全站 TabBar，需评估） | 全站 | 待办（共享件，单独评估） |

## 候选文件（grep `flex-wrap` 命中，含非工具栏，迁移前需逐个甄别）

`report-agent/components/*`（10+ 处）、`open-platform/*Panel`、`ccas-agent/*`、`review-agent/*`、`ai-toolbox/components/*`、`LlmLogsPage`、`ModelManagePage`、`UsersPage`、`literary-agent/*`、`ExchangeManagePage`、`tech-doc-format-agent` 等。注意：`flex-wrap` 也用于标签云/表单，并非都是工具栏，迁移前先确认是"按钮工具栏"。

## 防回潮

- 新页工具栏一律走上面四个原语；`mobile-first-density` 规则补一条"工具栏必须用 MobileOverflowMenu/Fab/Segmented 承载"。
- 共享件（`DocBrowser` 的读/编工具栏、`TabBar` 的换行）改动影响多消费方，单独评估、单独验收，不与单页迁移混做。

## 已知边界

- 知识库详情工具栏里「目录/返回/全屏/批注栏/内联/评论/历史版本/编辑」大多来自共享 `DocBrowser`（3 处复用），改它等于改 3 个消费方，必须按共享件流程谨慎处理，列在 P0 但单独排期。
- 移动端 FAB 暂未承接桌面创建按钮上的 `data-tour-id="document-store-create"` 锚点，移动端该步教程定位待补（低优先）。
