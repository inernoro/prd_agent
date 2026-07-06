| ops | prd-agent | LLM Gateway 生产部署和回滚后自动刷新 gateway，避免 Docker DNS 旧 upstream 导致公网 502 |
| ops | prd-agent | LLM Gateway 发布脚本读取 .env 中的有效模式、allowlist 与 shadow 采样配置，避免误判 release gate |
| test | prd-api | 补充 LLM Gateway pinned 模型合同测试并纳入 readiness gate，防止 ModelLab/Arena 选中模型被默认池覆盖 |
