# debt.report-detail

| 字段 | 内容 |
|---|---|
| 模块 | 周报详情页（report-agent） |
| 状态 | open · 已评估不合 |
| 关联 | `prd-admin/src/pages/report-agent/ReportDetailPage.tsx`（900+ 行）、`prd-admin/src/components/doc-browser/DocBrowser.tsx`、`prd-api/src/PrdAgent.Core/Models/ReportTeam.cs`、`prd-api/src/PrdAgent.Core/Models/ReportWeekly*.cs` |
| 创建 | 2026-05-28 |

---

## 背景

2026-05-28 做"统一文档阅读器"时盘点了所有左右分栏阅读型页面。**周报详情页 `ReportDetailPage.tsx` 评估后明确不融合 DocBrowser**，本文件记录原因与未来若要做需要的前置条件。

注意区分两个"周报"概念：

| 名字 | 实际是什么 | 是否已融合 DocBrowser |
|------|----------|---------------------|
| 更新中心-周报 (`WeeklyReportsTab`) | 知识库 `document_stores` 里一个 store 的列表+正文 | ✅ 2026-05-28 已融合（appearance="cards"）|
| **周报详情 (`ReportDetailPage`)** | report-agent 业务实体 `WeeklyReport` + `TeamReportListItem` 矩阵 | ❌ **本文件登记的债** |

二者底层数据完全不同，长得也不像，只是名字撞了。

---

## 为什么不融合 DocBrowser

`ReportDetailPage` 是 **report-agent 的领域页面**，不是文档阅读器。它的左右分栏装的是业务实体，不是文件：

- **左侧 sidebar**：`SiblingReportsSidebar`——成员 × 周次矩阵，每条带「草稿/已提交/已审阅」状态徽章、提交日期、审阅人头像、点赞数。**不是 folder/file 树**，是业务实体列表
- **右侧主区**：多 tabs（内容 / 计划对比 / 评论），每个 tab 独立内容
- **右栏 panel**：「快速面板」含团队总结、贡献者卡片、关键脉络 mermaid 图、提交分布柱状图
- **顶部 actions**：「编辑」「提交审阅」「分享」「导出」按钮（按角色和状态变化）

DocBrowser 的核心契约是 `entries: DocBrowserEntry[]` + `loadContent(id) → text`——这是"一个文件树渲染器"。`WeeklyReport` 是"一份带工作流的业务报告"，强行映射会丢失：
- 状态机（草稿/提交/审阅）
- 跨实体关联（成员、团队、周次）
- 多 tabs
- 右栏复合面板

降级的代价 > 复用的收益。

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| RD-1 | **DocBrowser 缺 leftSidebar slot 系统**：要让 DocBrowser 装得下"成员×周次矩阵 + 状态徽章 + 头像"，至少要把左侧 sidebar 整个改成可注入 slot（`renderEntryRow?: (entry, ctx) => ReactNode`），同时保留默认的 file 渲染。改造面大，破坏现有契约。 | P3 | 团队要做"统一一切左右分栏页"项目 | open |
| RD-2 | **DocBrowser 缺 rightPanel slot 系统**：周报右栏的「快速面板」（团队总结/贡献者/mermaid/柱状图）是周报独有，DocBrowser 现在只有"右侧渲染当前选中文档"。需要给 DocBrowser 加 `renderRightPanel?: (selectedId) => ReactNode` 或更激进的"三栏布局" prop。 | P3 | 同 RD-1 | open |
| RD-3 | **DocBrowser 缺 entryBadges 系统**：周报每条左侧条目需要带「草稿/已提交/已审阅」状态徽章、审阅人头像组、点赞数、评论数。当前 DocBrowser 只支持 `lastChangedAt` NEW 徽章 + 本次新增的 `isEntryFresh`。要支持业务级 badges 需要 `renderEntryBadges?: (entry) => ReactNode`。 | P3 | 同 RD-1 | open |
| RD-4 | **若以上 3 个 slot 都加齐，DocBrowser 会膨胀成"万能左右分栏框架"**：违反 SSOT 原则——「DocBrowser 是文档浏览器」这个边界会模糊。届时应该考虑反向重构：把 DocBrowser 拆成 `<SplitPaneReader>`（左右分栏 + 拖拽 + 主题）+ `<DocEntryList>`（文档专用左侧）+ `<DocEntryPreview>`（文档专用右侧），周报和殿堂各自组合自己的 EntryList/Preview。 | P2（架构隐患） | RD-1/2/3 任一开始动 | open |

---

## 重新评估的条件

下面任一条件满足时，才值得重新启动融合评估：

1. report-agent 决定彻底重写，主动来对齐 DocBrowser
2. 团队启动"统一所有左右分栏页"项目（含殿堂、周报、未来的新阅读页），愿意承担 RD-4 的反向重构成本
3. 周报详情的 sidebar / rightPanel 业务变化已经超过 5 处独立实现，维护成本超过融合成本

**当前不满足任一条件 → 维持现状，不动**。

---

## 反面参考

✗ "把周报详情塞进 DocBrowser"——RD-1/2/3 全堵在那，硬塞会丢领域语义
✗ "给 DocBrowser 加 5 个 slot prop"——RD-4 警告：组件膨胀成万能框架，谁都改不动

正确路径：等业务自然演进到 RD-4 触发条件，再做一次反向重构。
