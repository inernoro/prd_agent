| ops | scripts | LLM Gateway 发布 gate 拆分生产 stage、readiness、release gate、rollout ledger、备份和回滚脚本，默认不切 full-http |
| ci | github-actions | 新增 LLM Gateway 生产阶段 workflow，可按 shadow、config-authority、canary、http-full 和 rollback 阶段留存证据 |
| ops | docker | 为 API/GW compose 增加 LLM Gateway 发布 gate 所需配置透传，保持默认不启用 full-http |
