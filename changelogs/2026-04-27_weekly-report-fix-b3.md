| feat | prd-api | `ReportTeamMember` 新增 `IsExcused` 字段(默认 false),`UpdateTeamMember` 端点接受 `isExcused` 用于设置免提交标记 |
| feat | prd-api | `GetTeamReportsView` 实时计算逾期(本周日 23:59 中国时区已过 → Draft/NotStarted 视图层 map 为 Overdue,不修改 DB);响应新增 `submissionDeadline` + `isPastDeadline` 字段 |
| feat | prd-api | 团队周报列表统计排除 Leader 与 Excused 成员 — `totalMembers/submittedCount/pendingCount` 仅算活跃成员;成员管理 drawer 仍展示完整列表(每行带 `isExcused`) |
| feat | prd-admin | 团队周报列表头部新增「截止于/已过截止 MM-DD HH:mm」chip,逾期红色提示;成员管理 drawer 每行新增「免提交/取消免提交」按钮(Leader 行隐式锁定免提交,不可关闭) |
