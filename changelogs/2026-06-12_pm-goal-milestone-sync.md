| fix | prd-admin | 目标设为里程碑后「里程碑」tab 看不到：GoalsPanel 联动操作（设为/取消里程碑、删目标）通过 onMilestonesChanged 通知父级刷新 milestones，不再依赖整页刷新 |
| fix | prd-admin | 里程碑日历视图新增「未排期」区域：无截止日的里程碑（含目标联动里程碑）不再隐身，可点开补日期 |
| fix | prd-api | 删除目标时级联清理 AutoFromGoal 联动里程碑，不再留孤儿数据（手动建的关联里程碑不动） |
| feat | prd-api | 里程碑列表返回 autoFromGoal 字段，前端可区分目标联动里程碑 |
| feat | prd-admin | 目标/里程碑视觉区分：联动里程碑在时间轴/日历/管理条/详情抽屉显示 Target 图标 + 「来自目标」紫色标记；设为里程碑的目标在列表卡与画布节点常显紫色 Flag 标记 |
| feat | prd-api | AI 项目简报：POST /api/pm/projects/:id/briefings/generate SSE 生成（硬数据服务端统计 + LLM 结构化内容 + 模板渲染自包含 HTML），简报列表/详情/删除端点，pm_briefings 集合，注册 pm-agent.briefing::chat |
| feat | prd-admin | 报表 tab 新增「项目简报」区块：生成（SSE 阶段/思考/逐字全程可视化 + 模型名展示）、历史列表、iframe 预览、下载 HTML 单文件 |
| feat | prd-api | 简报分享与托管：POST /briefings/:id/share 开关分享（可撤销 token），GET /briefings/shared/:token 匿名直出 HTML，POST /briefings/:id/save-to-hosting 一键存网页托管；审计过滤器登记简报动作 |
| feat | prd-admin | 简报预览弹窗新增「开启分享/复制链接/撤销分享」「保存到网页托管」操作，列表显示分享中/已托管标记 |
