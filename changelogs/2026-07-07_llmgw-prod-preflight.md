| ops | prd-agent | 新增 llmgw-prod-preflight.py 只读生产预检，支持 start/completion 两种模式检查 MAP 日志权限、GW serving key 与 rollout ledger 终态证据 |
| ops | prd-agent | llmgw-prod-stage.sh 真实发布阶段接入生产预检，并把 prod-preflight.json 纳入 rollout ledger 成功证据 |
