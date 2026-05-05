| feat | prd-api | 新增 CLI Agent 执行器 claude-sdk，通过 Python sidecar 调用 Anthropic Agent SDK，支持本地 / docker-compose / 跨服务器 sandbox 三种部署形态
| feat | prd-api | 新增 IClaudeSidecarRouter 多实例路由（健康检查 + 标签 + 粘性 + 加权），暴露给 CapsuleExecutor.ExecuteCliAgent_ClaudeSdkAsync 使用
| feat | prd-api | appsettings.json 增加 ClaudeSdkExecutor 配置段，默认 Enabled=false，CDS 通过环境变量 ClaudeSdkExecutor__* 覆盖
| feat | claude-sdk-sidecar | 新建 Python FastAPI 服务，提供 /v1/agent/run SSE 流式接口和 /healthz /readyz 探针，多轮 tool_use 循环 + 工具桥接 stub
| feat | docker | docker-compose.dev.yml 增加 claude-sidecar service（profile=claude-sdk，默认不启动）
| docs | doc | 新增 doc/design.claude-sdk-executor.md 与 doc/debt.claude-sdk-executor.md 记录架构与已知边界
