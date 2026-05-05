| feat | prd-api | 新增 CLI Agent 执行器 claude-sdk，通过 Python sidecar 调用 Anthropic Agent SDK，支持本地 / docker-compose / 跨服务器 sandbox 三种部署形态
| feat | prd-api | 新增 IClaudeSidecarRouter 多实例路由（健康检查 + 标签 + 粘性 + 加权），暴露给 CapsuleExecutor.ExecuteCliAgent_ClaudeSdkAsync 使用
| feat | prd-api | 零配置自启：检测到 ANTHROPIC_API_KEY 环境变量后 PostConfigure 自动注入 default sidecar 并启用执行器，docker compose up 即可
| feat | prd-api | 新增 IAgentToolRegistry + 内置工具 echo / current_time，AgentToolsController 提供 /api/agent-tools/{list,invoke}，sidecar 可反向调主服务工具
| feat | prd-api | ExecuteCliAgent_ClaudeSdkAsync 写 llmrequestlogs（StartAsync / MarkFirstByte / MarkDone / MarkError），账单页可见 claude-sdk 调用
| feat | claude-sdk-sidecar | 新建 Python FastAPI 服务，提供 /v1/agent/run SSE 流式接口和 /healthz /readyz 探针，多轮 tool_use 循环 + ToolBridge 反向调用主服务
| feat | docker | docker-compose.dev.yml 增加 claude-sidecar service，默认包含（无 profile），随 compose up 一起启动
| docs | doc | 新增 doc/guide.claude-sdk-quickstart.md（三步无脑配置）+ design / debt 文档同步更新到 v0.2
