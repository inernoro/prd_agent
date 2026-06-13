| fix | prd-api | 项目管理：目标标题/描述/负责人更新后级联同步到联动里程碑(AutoFromGoal)，修复里程碑显示旧目标名 |
| fix | prd-admin | 项目管理：目标编辑保存后刷新父级 goals/milestones，里程碑「关联目标」下拉与列表同步最新目标名 |
| feat | prd-admin | 项目管理：目标/里程碑/任务/立项表单新增草稿缓存(sessionStorage)，误关弹窗或误跳页后重开自动恢复未保存内容 |
| feat | prd-admin | 项目管理：目标支持同级拖拽排序 + 向上/向下添加同级；里程碑支持拖拽排序(改为手动顺序优先) |
| feat | prd-api | 项目管理：新建目标支持指定 OrderKey，用于「向上/向下添加同级」按相邻中值定位插入点 |
| feat | prd-api | 项目管理：新增全局总览只读端点(global/projects + global/summary)，跨全公司项目多维筛选+健康预警+经营汇总+负责人负载，权限 pm-agent.global |
| feat | prd-admin | 项目管理：新增「全局总览」菜单(NPSS看板上方，仅管理层)，四块只读洞察(项目总表/健康预警/经营汇总/负载分析) |
