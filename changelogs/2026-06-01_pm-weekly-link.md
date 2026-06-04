| feat | prd-api | 项目周报支持从周报Agent个人周报导入：新增 GET /pm/weekly-reports/importable（按 report-agent 可见性聚合：作者/leader·deputy/all_members/全局）+ POST /pm/projects/{id}/weekly-reports/import（服务端二次校验+快照渲染为 markdown+回溯 SourceReportId） |
| feat | prd-api | 目标/任务/周报关联建模：PmTask 加 GoalId（成果轴，与 MilestoneId 正交）；PmWeeklyReport 加 RelatedGoalIds/RelatedTaskIds/SourceType/SourceReportId；目标 auto 进度改为「直接任务∪里程碑任务」完成率 |
| feat | prd-admin | 项目周报面板加「导入个人周报」选择器（权限内）+ 周报可关联目标/任务（编辑勾选、阅读展示 chips+来源徽章）；任务详情抽屉加「所属目标」选择器（与里程碑并列） |
| feat | prd-admin | 目标详情抽屉新增反查区：关联任务（直接挂的+里程碑下的，带状态）+ 提及本目标的周报，关系闭环可见 |
| feat | prd-admin | 导入个人周报改为两步：选周报→按「作者+本周窗口」自动勾选推进任务（可调整）→确认导入；目标反查列表点击可跳转到对应任务/周报 |
