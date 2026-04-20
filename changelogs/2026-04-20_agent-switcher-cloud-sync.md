| feat | prd-api | UserPreferences 新增 AgentSwitcherPreferences（pinnedIds / recentVisits / usageCounts）+ PUT /api/dashboard/user-preferences/agent-switcher 端点，命令面板置顶 / 最近 / 常用改为云端同步 |
| feat | prd-admin | agentSwitcherStore 新增 loadFromServer + flushToServer + resetServerSync，mutation 后 800ms debounce 自动回写；AppShell 登录后拉取、登出时重置。换分支 / 浏览器不再丢数据 |
