| fix | prd-llmgw | 修复网关控制台永久锁死：历史遗留 admin 账号口令未知且旧逻辑在保护它，导致从没人能登录进去。改为内置 admin/admin 引导 + 首登强制改密，完全移除 env 口令依赖（CDS _global env 注入不可控，靠 env 设口令会锁死控制台）。未被真人认领的账号每次启动确定性自愈回 admin/admin（重置=重新部署），UI 改过口令的账号保留不回退 |
| feat | prd-llmgw | LlmGwUser 加 PasswordChangedByUser；change-password 成功置 true，保住用户新口令跨重启不被自愈覆盖。真机全链路取证通过（登录→强制改密→mcp 403→解锁→重启不回退） |
