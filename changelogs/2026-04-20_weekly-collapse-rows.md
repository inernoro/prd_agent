| perf | prd-admin | 周报 tab 合并上两行：来源 chip 栏 + 添加按钮挪进 TabBar 的 actions 槽（与「更新中心/周报」同一行），删除冗余的 LIVE 信息条（知识库名/关键词通过「周报列表」header 的 tooltip + chip 悬停查看） |
| refactor | prd-admin | 抽出 WeeklyReportSourcesProvider Context（sources / activeId / stores / CRUD handlers 统一管理），供 TabBar actions 与 WeeklyReportsTab 共享；页面从 3 行压缩为 1 行顶栏 + 主体 |
