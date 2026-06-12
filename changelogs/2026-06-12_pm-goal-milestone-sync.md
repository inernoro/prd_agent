| fix | prd-admin | 目标设为里程碑后「里程碑」tab 看不到：GoalsPanel 联动操作（设为/取消里程碑、删目标）通过 onMilestonesChanged 通知父级刷新 milestones，不再依赖整页刷新 |
| fix | prd-admin | 里程碑日历视图新增「未排期」区域：无截止日的里程碑（含目标联动里程碑）不再隐身，可点开补日期 |
| fix | prd-api | 删除目标时级联清理 AutoFromGoal 联动里程碑，不再留孤儿数据（手动建的关联里程碑不动） |
| feat | prd-api | 里程碑列表返回 autoFromGoal 字段，前端可区分目标联动里程碑 |
| feat | prd-admin | 目标/里程碑视觉区分：联动里程碑在时间轴/日历/管理条/详情抽屉显示 Target 图标 + 「来自目标」紫色标记；设为里程碑的目标在列表卡与画布节点常显紫色 Flag 标记 |
