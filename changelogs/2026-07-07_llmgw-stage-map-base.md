| ops | prd-agent | LLM Gateway 生产 stage preflight 兼容 `LLMGW_STAGE_MAP_BASE`，避免 shadow-start 按帮助文档执行时误报缺少 MAP 地址 |
| test | prd-api | 补充 LLM Gateway 生产 stage MAP 地址变量静态守卫，防止 preflight 与 stage 参数再次漂移 |
