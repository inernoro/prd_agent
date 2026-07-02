| security | prd-llmgw | 网关控制台首登强制改密：缺省 admin/admin 账号种子 MustChangePassword，登录返回标记 + JWT 带 mcp claim，LogsRead 策略门在改密前拒绝该 token 访问 /gw/logs* |
| feat | prd-llmgw | 新增 /gw/auth/change-password 端点（校验旧口令→写新哈希→清标记→重签发不带 mcp 的 token）；SeedAdmin 分「默认弱口令/配置口令」两模式，默认模式重启不再回退已改口令 |
| feat | prd-llmgw-web | 新增首登强制改密页 ChangePasswordPage + 路由守卫（mustChangePassword 时强制跳转），auth/api 接线改密流程 |
