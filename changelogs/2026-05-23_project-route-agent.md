| feat | prd-api | 新增「项目路由智能体」(appKey: project-route-agent)：Controller / Models / GitRepoCacheService（浅克隆任意第三方仓库 + 读 routemap/ 目录）+ 内联 SSE 两阶段 LLM 分析 |
| feat | prd-api | AppCallerRegistry 注册 project-route-agent.extract.apps::chat 与 project-route-agent.resolve.routemap::chat |
| feat | prd-api | AdminPermissionCatalog + BuiltInSystemRoles 新增 project-route-agent.use / project-route-agent.manage |
| feat | prd-admin | 新增 /project-route-agent 页面：上传方案 md → AI 抽应用/模块 → 克隆仓库 → 匹配 routemap 项目路径；管理员 Tab 维护公共站点说明 + 仓库登记表 |
| feat | prd-admin | toolboxStore / navRegistry / shortLabel / authzMenuMapping 注册「项目路由智能体」入口（wip: true） |
