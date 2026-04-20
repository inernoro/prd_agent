| feat | prd-api | 新增 ChangelogReportSource 模型 + changelog_report_sources 集合 + /api/changelog/sources CRUD API，周报来源配置全员共享 |
| feat | prd-admin | 周报 tab 重构为多来源模型：支持全员添加/编辑/删除，从数据库加载，替代原来只在 sessionStorage 里每人各自保存的设置 |
| feat | prd-admin | 新增 MermaidDiagram 组件（懒加载 mermaid 主包），MarkdownContent 对 mermaid 代码块自动渲染图表，不再暴露源码 |
| refactor | prd-admin | 更新中心移除「本周更新」冗余 section，保留历史发布；周报改由「map周报」tab 承载 |
| perf | prd-admin | 周报来源选择采用 chip 栏 + hover 内联编辑/删除，视觉与 Surface System 对齐 |
