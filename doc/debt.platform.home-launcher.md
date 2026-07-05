# 登录后首页（Agent 启动页）· 债务台账

> **版本**：v1.0 | **日期**：2026-07-05 | **状态**：方向 C（工作台·内容优先）首版已落地，本文记录已知边界与后续可补项
> **关联改动**：`prd-api/src/PrdAgent.Api/Controllers/Api/HomeRecentWorkController.cs`、`prd-admin/src/pages/AgentLauncherPage.tsx`、`prd-admin/src/stores/homeRecentWorkStore.ts`

记录登录后首页重组（继续上次 + 视觉纪律收敛）主动声明的已知边界，避免下一次 session 没人记得。

## 一、已落地

- **「继续上次」区块**：`GET /api/home/recent-work` 聚合视觉/文学工作区（`image_master_workspaces`，按 `scenarioType == article-illustration` 区分归属）与工作流（`workflows`），按 `LastOpenedAt/UpdatedAt` 较大者排序；前端无数据时整体不渲染。
- **色阶尺（tonal ladder）**：46 对渐变强调色收敛为 `hueAccent(H)`（同一饱和度/明度档位只换色相），颜色只出现在图标芯片；卡片底/描边/hover 一律中性。
- **卡片统一配方**：Featured / Quick / Compact / RecentWork 四种卡同底同描边同 hover ring。
- **动画收敛**：问候语彩虹渐变动画删除；进场动画由 30+ 元素逐卡级联降为区块级一次 fade（400ms）。

## 二、已知边界（后续可补）

| # | 边界 | 说明 | 补法 |
|---|------|------|------|
| 1 | 「继续上次」数据源仅 3 类 | 目前只聚合视觉/文学工作区与工作流；缺陷单、知识库、周报、涌现树等未纳入 | 在 `HomeRecentWorkController` 按同一模式增加来源（各集合按 owner + 时间字段取 top N 合并） |
| 2 | ~~实体全局时间戳近似~~（已修复 2026-07-05） | 首版用实体 `UpdatedAt/LastOpenedAt/LastExecutedAt` 近似"我的最近"，实测共享成员编辑、定时工作流自跑会顶进所有用户的继续上次（用户反馈"人人一样且不是自己操作的"）。已改为每用户台账 `home_recent_opens`（打开详情时 `RecentOpenTracker.TouchAsync` 打点），端点只读台账 | 已闭环；禁止回退全局时间戳方案 |
| 3 | 台账冷启动为空 | 上线后所有用户的继续上次会清空，重新打开过工作区/工作流才逐渐积累（每次打开打一条） | 属预期行为（诚实优于杜撰）；如需回填可按各实体 owner 的 LastOpenedAt 一次性初始化，需评估共享工作区归属口径 |
| 4 | 移动端首页未同步方向 C | `MobileHomePage` 是独立实现（2026-07-01 已另行改版为移动工作台），本次只改桌面 AgentLauncherPage | 如需移动端也加「继续上次」，复用 homeRecentWorkStore 即可 |
| 5 | 登录后 UI 视觉验收待真人 | 本次自测覆盖 vitest/tsc/lint/pnpm build/CDS 编译 + AI key 冒烟端点；登录态页面截图验收需真实账号走 /验收 流程 | 用户在预览域名登录验收，或提供测试账号后补跑视觉验收归档 |

## 三、不做的事（明确否决）

- 不再为每个图标维护独立渐变对（回到 46 色状态即视为回归）。
- 「继续上次」不做骨架屏：拉取失败或为空时静默隐藏，不打扰用户。
