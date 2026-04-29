| feat | cds | 新增 AppShell / TopBar / Workspace 共享布局组件，统一所有 React 页面的左侧导航条、顶部面包屑和工作区宽度 |
| feat | cds | 引入 surface 三档视觉系统（base / raised / sunken）与 hairline 边框 token，替代过去 `bg-card border-border` 的灰底灰边堆叠 |
| refactor | cds | ProjectListPage 主链路收敛：顶部「粘贴 Git URL」hero 表单成为唯一主操作；项目卡改为 Railway-style 极简卡片（状态点 + 标题 + 仓库 + 内联指标 + 进入按钮）；自动化工具（技能包 / 全局 Key / Agent 申请记录）下沉到二级折叠面板 |
| refactor | cds | ProjectListPage 顶部统计移到 TopBar 内联 `cds-stat`，不再占据独立卡片层级；`MetricTile` 在该页面退役为局部使用 |
