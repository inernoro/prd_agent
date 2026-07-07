| ops | prd-agent | LLM Gateway 生产 stage preflight 兼容 `LLMGW_STAGE_MAP_BASE`，避免 shadow-start 按帮助文档执行时误报缺少 MAP 地址 |
| test | prd-api | 补充 LLM Gateway 生产 stage MAP 地址变量静态守卫，防止 preflight 与 stage 参数再次漂移 |
| ops | prd-agent | ASR HTTP canary 外部阻断证据补充模型、状态码和上游错误，便于 video-asr gate 直接定位凭据问题 |
| ops | prd-agent | 新增 LLM Gateway 生产 ASR 凭据安全轮换脚本，默认 dry-run，执行前备份 `model_exchanges` 并通过 MAP API 完成应用侧加密 |
| test | prd-api | 补充 ASR 凭据轮换脚本静态守卫，防止绕过备份或应用加密 |
| fix | prd-agent | rollback rehearsal 记录 release main SHA 但不做 main ancestry 阻断，仍保留 canary/http 发布阶段的 main 合入保护 |
| feat | prd-api | LLM Gateway shadow 支持按 appCaller 强制 full sample，便于图片/ASR/video raw 发布证据确定性采样 |
| ops | prd-agent | 发布、回滚和 shadow restore 脚本接入并清理 `LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST`，避免 raw 采样配置长期滞留 |
| fix | prd-agent | `exec_dep.sh` 将 per-app full sample allowlist 也纳入 LLM Gateway 发布 gate，防止 raw 采样发布绕过 stage runner |
| test | prd-api | 补充 raw shadow 强制采样与运维变量守卫，防止发布证据再次退化为随机命中 |
