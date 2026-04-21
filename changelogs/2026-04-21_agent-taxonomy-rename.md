| refactor | prd-admin | 统一智能体/工具/基础设施三桶分类:`ToolboxItem` 新增 `kind?: 'agent' \| 'tool' \| 'infra'`;BUILTIN_TOOLS 9 项标 `kind: 'agent'`(PRD 解读/视觉创作/文学创作/缺陷管理/视频创作/周报/AI 竞技场/产品评审/PR 审查),6 项标 `kind: 'tool'`,更新中心与工作流引擎下放基础设施 |
| refactor | prd-admin | `AgentLauncherPage` 首页新增「基础设施」分组:知识库 / 我的资源 / 海鲜市场 / 模型中心(mds.read)/ 团队协作(users.read)/ 工作流引擎 / 网页托管 / 更新中心,与智能体/实用工具并列展示,支持权限门控 |
| refactor | prd-admin | `launcherCatalog.ts` 新增 `buildInfraItems()` + `LauncherGroup` 扩 `'infra'`;涌现探索划归 `group: 'agent'`;`AgentSwitcher` 浮层同步新增「基础设施」分区 |
| refactor | prd-admin | 统一智能体命名:`智能助手` → `智能体`;内联短名 Agent → 智能体(视觉 Agent → 视觉创作智能体 等)统一到 authzMenuMapping / homepageAssetSlots / landing mocks / 页面标题(ReviewAgentPage / PrReviewPage / VideoAgentPage / MobileHomePage) |
| refactor | prd-admin | `ProjectDialog` placeholder `智能助手` → `智能体` |
| refactor | prd-api | `AdminPermissionCatalog` 权限标签统一改为智能体后缀(PRD 解读智能体/视觉创作智能体/文学创作智能体/缺陷管理智能体/视频创作智能体/AI 竞技场智能体/周报智能体/产品评审智能体/PR 审查智能体/转录智能体/数据迁移智能体/技能引导智能体) |
| refactor | prd-api | `AiToolboxController` 兜底 systemPrompt `智能助手` → `智能体` |
