| ops | prd-agent | LLM Gateway 生产 stage preflight 兼容 `LLMGW_STAGE_MAP_BASE`，避免 shadow-start 按帮助文档执行时误报缺少 MAP 地址 |
| test | prd-api | 补充 LLM Gateway 生产 stage MAP 地址变量静态守卫，防止 preflight 与 stage 参数再次漂移 |
| ops | prd-agent | ASR HTTP canary 外部阻断证据补充模型、状态码和上游错误，便于 video-asr gate 直接定位凭据问题 |
| ops | prd-agent | 新增 LLM Gateway 生产 ASR 凭据安全轮换脚本，默认 dry-run，执行前备份 `model_exchanges` 并通过 MAP API 完成应用侧加密 |
| test | prd-api | 补充 ASR 凭据轮换脚本静态守卫，防止绕过备份或应用加密 |
