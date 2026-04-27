| feat | prd-api | `ReportTeam.WeeklyDeadline` 团队级周报截止时间字段(默认 "sunday-23:59" UTC+8),Create/Update 端点接受配置 |
| feat | prd-api | `GetTeamReportsView` 用 `ResolveWeekDeadline` 按团队配置解析(替代之前硬编码周日 23:59) — 支持 monday/tuesday/.../sunday + HH:mm |
| feat | prd-admin | 团队设置新增「周报提交截止时间」下拉(周五 12/18/20、周六 12/18、周日 18/23:59、下周一 09/10) — 解决之前用户无法配置截止时间的问题 |
