| fix | prd-llmgw | 控制台日志与 runtime gates 改读 llm_gateway 自有请求日志，避免 full-http 证据被误查到 MAP 日志库 |
| fix | docker-compose | 为 llmgw 控制台容器补齐 rollout ledger 只读挂载和 MAP fallback 退场开关环境变量 |
| test | prd-api | 增加 LLM Gateway 数据域与 compose 配置静态守卫，防止日志权威库回退 |
