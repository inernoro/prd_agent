| security | prd-llmgw | 生产环境强制显式配置 LLMGW_JWT_SECRET / LLMGW_ADMIN_PASSWORD（缺失或为仓库 dev 占位值则拒绝启动），防止 /gw/* 被自签 token 读取 |
| security | prd-api | docker-compose 的 LLMGW_JWT_SECRET 改为必填（删除空默认），与 SERVE_KEY/ADMIN_PASSWORD 对齐 |
| fix | prd-api | 修复 blackhole 日志误标成功调用：StartAsync 失败返回 null 使记录不被覆盖/反向误标，移除 Status 兜底过滤 |
| fix | prd-admin | LLM 日志 blackhole 状态标签「未发出」改为「记录降级」（请求可能已成功，仅日志未落库） |
| fix | prd-llmgw | LLM 日志 blackhole 状态标签「未发出」改为「记录降级」 |
| fix | prd-api | http 模式 multipart raw（ASR/图生图）跨进程未接通时快速失败（MULTIPART_HTTP_UNSUPPORTED），防止静默发出丢文件的请求 |
| fix | cds | compose cds.subdomain 重复声明时去重（首个保留，后续丢弃），forwarder 命名子域去重按 profileId 排序保证确定性 |
