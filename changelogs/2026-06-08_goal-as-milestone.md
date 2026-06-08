| fix | prd-admin | 修复里程碑详情日期/负责人行样式错乱:两个日期同行各占半,负责人独占一行 |
| feat | prd-api | 目标可设为里程碑:POST /api/pm/goals/:id/milestone 开/关,开→建联动里程碑(AutoFromGoal,GoalId 关联),关→删;PmMilestone 加 AutoFromGoal;目标列表返回 isMilestone |
| feat | prd-admin | 目标「设为里程碑」开关:画布(GoalDetailDrawer)开关 + 列表行 Flag 按钮,设置后在里程碑同步显示,团队/个人目标均支持 |
