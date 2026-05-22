| feat | prd-api | DailyLogItem 新增 CompletedAt 字段（Todo 完成时间快照） |
| feat | prd-api | UserPreferences.ReportAgentPreferences 新增 DailyLogTagOrder / DailyLogDefaultTags 字段；GET/PUT /api/report-agent/my/daily-log-tags 响应与入参扩展 tagOrder + defaultTags |
| feat | prd-admin | 日常记录中央列加「本周待办」置顶卡片，跨日聚合所有本周未完成 Todo，hover 显示「✓ 标记完成 + 🗑 删除」 |
| feat | prd-admin | Todo 行操作按钮区分：未完成 → 「✓ 标记完成 + 🗑 删除」、已完成 → 「已完成」chip + 删除；非 Todo 维持「编辑 + 删除」 |
| fix | prd-admin | 去掉默认勾选「开发」标签，进入今日打点默认空选；用户在「管理标签」勾选的默认标签会自动应用 |
| feat | prd-admin | 管理标签面板重写：系统 + 自定义标签统一拖动排序、可勾选默认；系统标签不可删，自定义可重命名/删除 |
