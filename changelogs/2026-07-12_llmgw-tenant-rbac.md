| feat | prd-api | LLM Gateway 运行时增加租户解析、tenant-first 数据隔离及跨租户预算、幂等、取消和并发治理 |
| feat | prd-llmgw | 新增租户、团队、成员、角色权限、租户切换与 tenant-scoped 控制台 API |
| security | prd-llmgw | 服务 key、日志、审计、路由配置和组织资源按服务端租户上下文隔离 |
| test | prd-api | 新增 service key、请求幂等、取消注册和 provider 并发的跨租户隔离测试 |
| fix | prd-api | 生命周期保留任务覆盖全部租户的日志脱敏、对象清理和逐租户审计记录 |
| security | prd-api | 外部租户模型池预览禁止回退 MAP，multipart 引用按租户 manifest 校验后再下载 |
| security | prd-api | multipart 清理仅在引用归属确认后执行，并只使用服务端已验证 TenantId |
| security | prd-api | inline multipart 文件绕过引用 rehydrate 时禁止清理未经 manifest 验证的 RefKey |
