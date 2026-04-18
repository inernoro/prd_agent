| fix | cds | 基础设施端点 (POST/PUT/DELETE/start/stop/restart/logs /api/infra[/:id...]) 全面项目化：`(projectId, id)` 复合唯一性、按 `?project=<id>` 或自动推断项目上下文、多项目冲突时 400 明示「请带 ?project=<id>」、container name 非 legacy 项目自动加项目 slug 前缀避免 Docker 级冲突 |
| fix | cds | 分支页头部 4 个冗余 shortcut 按钮移除（构建配置/环境变量/基础设施/路由规则），这些都在齿轮菜单里有 |
