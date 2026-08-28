| feat | cds | 角色提成共享 SSOT（agent-role-store），上手助手与任务地图读同一个值，不再是组件私有的一次性选择 |
| feat | cds | 新增「只换角色卡」脚本：不下技能、不联网、不碰 .env 和凭据，只替换受管区块 |
| feat | cds | 任务地图按角色排序并标注常用任务，五个角色不再看到同一串顺序 |
| feat | cds | 项目 Agent 角色声明落到 CDS：新增 GET/PUT /api/projects/:id/agent-profile，项目选择列表直接显示角色 |
| test | cds | 补角色差异与接线守卫：角色排序真的改变顺序、焦点表无幽灵任务、角色声明能被 /api/projects 带出 |
