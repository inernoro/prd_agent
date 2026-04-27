| feat | prd-api | 周报模板新增 `IssueList` 章节类型（问题）：章节级预设 `IssueCategories` / `IssueStatuses`；`WeeklyReportItem` 扩展 `IssueCategoryKey` / `IssueStatusKey` / `ImageUrls` 三个字段 |
| feat | prd-api | 新增端点 `GET /api/report-agent/teams/{id}/issues` — 按周聚合团队所有成员已提交周报的 IssueList 条目，支持 `categoryKey` / `statusKey` 筛选；权限规则对齐 `GetTeamReportsView`（全局 ViewAll / Leader-Deputy / ReportVisibility=AllMembers 的成员 → 看全员，否则仅看自己） |
| feat | prd-admin | 模板编辑器新增「问题」章节类型：选中后内嵌分类 / 状态预设编辑器（标签追加/删除），首次切换自动填入默认分类（技术/产品/流程/资源）+ 默认状态（新增/跟进中/已解决/阻塞） |
| feat | prd-admin | 周报编辑器新增 `IssueItemCard` 组件：富文本 textarea + 粘贴图片（走 markdown 嵌入，复用现有上传通道） + 分类/状态下拉选择 |
| feat | prd-admin | 周报详情页和侧栏详情弹窗展示 IssueList 章节：卡片化条目 + 分类/状态 chip |
| feat | prd-admin | 周报主视图新增顶部 segmented control「我的周报 / 团队问题」，新增 `TeamIssuesView` 组件 — 按周选择 + 分类/状态 segmented 筛选 + 按成员分组聚合展示 |
