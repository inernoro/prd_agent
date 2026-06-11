| feat | prd-api | 新增团队动态功能：全局白名单审计过滤器（ActivityLogActionFilter）自动留痕知识库/缺陷/周报/视觉/文学/网页托管 6 模块的关键写操作，新集合 activity_logs，新端点 /api/team-activity/logs + modules，新权限 team-activity.read |
| feat | prd-admin | 新增「团队动态」管理页（/team-activity）：按天分组时间线流，头像 + 「谁 在 哪个模块 做了什么《对象标题》」+ 相对时间，支持按成员/模块/时间范围筛选与加载更多 |
| test | prd-api | 新增 ActivityActionRegistryGuardTests：白名单 Controller.Action 复合键与真实 Controller 反射比对，防重命名后动态静默断流 |
