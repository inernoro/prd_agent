| feat | prd-api | 目标 OKR 第一波：结构化关键结果 KR——PmGoal 增 KeyResults(percent/number/currency/binary，起/当前/目标值)；目标进度 auto 模式下有 KR 时按 KR 完成度均值汇总(优先于任务滚动)；ListGoals 返回 keyResults/keyResultCount |
| feat | prd-api | 目标负责人可指派：PmGoal 增 LeadId/LeadName(与 OwnerId/可见性解耦)，Create/UpdateGoal 落库 |
| feat | prd-api | 目标信心 + 进展 check-in：新增 PmGoalCheckIn + pm_goal_checkins 集合 + GET/POST goals/{id}/checkins(进度/信心/说明，更新目标最新信心)；删除目标级联清 check-in |
| feat | prd-admin | 目标详情抽屉新增：关键结果 KR 编辑器(类型/起当前目标值/单位/实时完成度) + 负责人(UserSearchSelect) + 进展 check-in 时间线(信心 high/medium/low + 进度 + 说明) |
| feat | prd-admin | 目标列表卡片展示 KR 数 / 信心点 / 负责人 |
