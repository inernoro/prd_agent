| ops | prd-agent | 修正 LLM Gateway 首次 shadow-start 发布门禁，允许发布前延后 gateway 探针并把发布 key 注入 llmgw-serve |
| ops | prd-agent | LLM Gateway 生产 stage 增加 runner 可用性预检，缺少 self-hosted 生产 runner 时快速失败并产出证据 |
| ops | prd-agent | 新增 LLM Gateway 生产 runner bootstrap 脚本，标准化恢复 `self-hosted,prd-agent-prod` 发布执行通道 |
| ops | prd-agent | LLM Gateway 生产 stage dry-run 也写出 rollout stage 证据文件，避免只依赖 workflow 日志审计 |
| ops | prd-agent | 修正 LLM Gateway 生产 stage artifact 上传隐藏证据目录，确保 rollout evidence 能被下载审计 |
