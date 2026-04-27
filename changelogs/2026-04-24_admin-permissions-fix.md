| fix | prd-api | 涌现探索器从 admin 模块（emergence.read/write）改造为智能体级权限（emergence-agent.use），普通用户（operator/viewer/agent_tester）默认开放，修复管理员被拒 403 问题 |
| fix | prd-admin | 导航栏自定义面板按权限过滤可添加项，禁止"看得到加得进点开 403"——viewer 用户不再能误添加无权限的导航条目 |
| fix | prd-admin | 移除 PRD 解读智能体 Web 端所有入口（百宝箱、命令面板 Cmd+K、移动端浮层、落地页 Agent 网格、提示词测试跳转、路由），统一桌面端体验，老书签自动重定向首页 |
| fix | prd-admin | 用户列表新增「权限」列，独立显示 systemRoleKey，与业务角色（PM/DEV/ADMIN…）解耦，避免"名义管理员实际无权限"的鬼状态 |
| fix | prd-admin | 修复导航自定义"自动化规则"标签被截断为"自动化规"——shortLabel 增加前缀剥离逻辑，命中 SHORT_LABEL_MAP 后再用 |
