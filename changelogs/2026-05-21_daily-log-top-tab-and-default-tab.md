| feat | prd-admin | 周报 Agent 顶部新增「日常记录」Tab（位于「周报」之前），独立承载 DailyLogPanel + 我的记录子菜单 |
| refactor | prd-admin | 「周报」Tab 内的「日常记录」按钮 + showDailyLog 内嵌视图删除（已上移到顶级 Tab） |
| feat | prd-api | UserPreferences.ReportAgentPreferences 新增 DefaultTab 字段；新增 GET/PUT /api/report-agent/my/default-tab 端点 |
| feat | prd-admin | 「设置」新增「自定义登录页面」section，默认「团队」，可选「日常记录 / 周报 / 设置」共 4 项；登录后默认 Tab 按用户偏好；未设置时按团队成员关系兜底 |
| fix | prd-admin | 「本周待办」条目前面误导性的圆形 ✓ icon 删除（用户以为是操作按钮） |
