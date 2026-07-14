| security | llmgw | 收紧团队日志、组织成员、appCaller 与 service key 的跨团队访问边界 |
| security | llmgw | Tenant、Team、Membership 停用与用户改密后立即失效关联 key 或旧会话 |
| security | llmgw | 通配 service key 增加显式风险确认，并禁止团队密钥使用通配 appCaller |
| fix | llmgw | 为租户和成员创建增加自然键幂等重放与失败补偿，减少重复提交和可捕获异常留下的半成品数据 |
| fix | llmgw | 并发首次发现 appCaller 时只允许权威团队请求进入上游 |
| test | llmgw | 新增双租户双团队固定矩阵、用户安全版本、scoped key 生命周期、补偿故障注入与并发归属测试 |
| ci | llmgw | 为服务端 CI 提供带健康检查的 MongoDB，使租户隔离行为测试不再因缺少依赖失败 |
| test | prd-api | Mongo ID 约束允许独立网关新集合使用严格字符串序列化，同时继续禁止 ObjectId 生成器 |
