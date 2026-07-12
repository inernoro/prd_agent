# 前端导航历史（返回上一页）已知债务台账

> **版本**：v1.1 | **日期**：2026-07-12 | **状态**：开放

## 背景

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

## 债务清单

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | 教程引导跨页跳转仍 push（`SpotlightOverlay.tsx` navigateTo、`TipsDrawer`/`TipsRotator`） | 走完一套多页教程后，返回会逐步回放教程路径 | 教程步骤间跳转评估改 replace；需先确认 SpotlightOverlay 跨路由 poll 机制不受影响，故本次未动 |
| 2 | NavigationBridge（`App.tsx` bridge:navigate 事件）恒为 push | CDS Widget / 外部脚本触发的导航会压栈；属显式指令，多数场景合理 | 若出现「后台事件凭空插历史」投诉，给事件 detail 增加 replace 可选参数 |
| 3 | 百宝箱 cds-agent 条目仍走 `window.location.assign`（三处，有意保留） | 进入 CDS 终端整页刷新，路由历史序号重置，进入后首次 smart back 走兜底而非弹栈 | cds-agent 页面依赖整页环境，保留；若迁移为 SPA 内页面再回收 |
| 4 | 未逐页覆盖所有 `navigate('/xxx')` 型返回/跳转 | 长尾页面（如部分 admin 深页）可能仍有硬编码返回 | 后续「用户走到哪修到哪」，新代码一律用 useSmartBack，返回按钮禁止硬编码列表路由 |
| 7 | useHistoryBackedView 的刷新恢复按页降级 | 百宝箱 create/edit/running、工作流执行子视图依赖内存态，刷新后回落列表并清 param（不是恢复原视图）；知识库/涌现/缺陷/周报可完整恢复；百宝箱 detail 与技能详情已接 restoreReady（数据加载完成后重试恢复，Codex P2 已修） | 需要完整恢复的其余视图补「按 id 拉数据」的 onRestore |
| 8 | report-agent 页内编辑器与路由版详情页仍是两套实现 | 页内 `?report=` 走 hook，路由版 `/report-agent/report/:id` 各管各 | 后续收敛为一套（倾向路由版），届时删 store 的 showReportEditor |
| 5 | prd-desktop 为 Tauri 状态机导航（无浏览器历史），不在本次范围 | 桌面端返回为 `previousMode` 单层栈，深度 1 | 若桌面端出现同类反馈，把 `sessionStore.mode` 扩展为多层栈 |
| 6 | 移动端 TabBar「同级互切 replace」依赖 FIXED_TABS 根路径集合 | 新增底部 tab 时若忘记 path 一致性，replace 判定失效 | 新增 tab 时确认 `TAB_ROOT_PATHS` 自动包含（由 FIXED_TABS 派生，通常无需手动） |

## 验收口径

真实手机（或 DevTools 移动仿真）路径：首页 → 底部 tab 互切数次 → 进入任一 Agent 详情 →
右滑/浏览器返回，应一步回到进入详情前的页面；继续返回应直接离开 tab 簇回到进入前的真实上一页，
不再逐条回放 tab 导航页。桌面路径：设置/模型管理切多个 tab 后按浏览器返回，应直接离开该页。
