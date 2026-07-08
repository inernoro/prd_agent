| ops | prd-agent | LLM Gateway 生产部署和回滚后自动刷新 gateway，避免 Docker DNS 旧 upstream 导致公网 502 |
| ops | prd-agent | LLM Gateway 发布脚本读取 .env 中的有效模式、allowlist 与 shadow 采样配置，避免误判 release gate |
| test | prd-api | 补充 LLM Gateway pinned 模型合同测试并纳入 readiness gate，防止 ModelLab/Arena 选中模型被默认池覆盖 |
| fix | prd-api | 修正 ModelLab pinned gateway 调用的 transport 观测，避免已走网关的请求被误记为 direct |
| test | prd-api | 增加 direct transport 标记守卫，防止全量迁移证据被 stale direct 上下文污染 |
| feat | prd-api | 为 llmgw-serve 增加受密钥保护的 OpenAI-compatible chat/completions 入口，供 sidecar 工具循环经网关调用模型 |
| refactor | prd-api | CapsuleExecutor 的 claude-sdk 执行器默认改为经 llmgw-serve 的 openai-compatible 路径，不再向 sidecar 下发真实上游密钥 |
| ci | prd-agent | Branch Image 在 API/llmgw-serve 改动时同步产出 llmgw 与 llmgw-web 同 SHA 镜像，避免生产 commit 发布缺 tag |
