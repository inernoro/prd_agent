| fix | prd-llmgw | 修复网关控制台永久锁死：历史遗留 admin 账号口令未知且旧「默认模式不回退」逻辑在保护它，导致从没人能登录进去。新增 PasswordChangedByUser 字段，默认模式下未被真人认领的账号（含旧文档）每次启动确定性自愈回 admin/admin + 强制改密，控制台永远可从 admin/admin 进入（重新部署即「重置」）；用户改过口令的账号保留不回退 |
| feat | prd-llmgw | change-password 成功后置 PasswordChangedByUser=true，保住用户新口令跨重启不被自愈覆盖 |
