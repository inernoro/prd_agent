| fix | prd-api | ListTemplates 对普通成员放宽可见性 — 之前仅返回「系统+自己创建」,导致 Member 看不到团队关联模板,前端 hasTemplate=false 让「写周报」按钮消失。现改为系统∪自己创建∪自己所在任何团队关联的模板(编辑/删除仍由 CanManageTemplate 守卫,无权限降级) |
| fix | prd-admin | 「写周报」按钮常驻显示,无模板时 disabled + tooltip 指引联系团队负责人,避免按钮神秘消失 |
| fix | prd-api | GetReport 返回新增 canReview 字段（Leader/Deputy/全局 ReportAgentViewAll → true） |
| fix | prd-admin | ReportDetailPage「审阅通过/退回」按钮权限守卫 — 依赖后端 canReview + 防自审(userId 不等于当前用户),解决「成员竟然能审核别人周报」bug;后端 Review/Return 端点本来就有权限校验,本次只是补前端 UI 层 |
