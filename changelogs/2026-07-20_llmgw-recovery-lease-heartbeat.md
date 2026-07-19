| fix | llmgw | 为租户、成员和 owner provisioning 增加 recovery lease 心跳，防止长耗时正常请求被硬退出修复器误回滚 |
| test | prd-api | 增加 live provisioning 续租与到期后可修复的竞态回归测试 |
