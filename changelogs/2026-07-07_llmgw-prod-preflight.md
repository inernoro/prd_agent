| ops | prd-agent | 新增 llmgw-prod-preflight.py 只读生产预检，支持 start/completion 两种模式检查 MAP 日志权限、GW serving key 与 rollout ledger 终态证据 |
| ops | prd-agent | llmgw-prod-stage.sh 真实发布阶段接入生产预检，并把 prod-preflight.json 纳入 rollout ledger 成功证据 |
| ops | prd-agent | exec_dep.sh 禁止直接执行 LLM Gateway shadow/canary/http 发布，必须由 llmgw-prod-stage.sh 注入阶段上下文与台账证据 |
| ci | prd-agent | 新增 llmgw-prod-preflight workflow，支持在 GitHub Secrets/Vars 环境中运行 start/completion 生产预检并上传 prod-preflight.json |
| ci | prd-agent | 新增 llmgw-prod-stage workflow，支持在生产 self-hosted runner 上执行分阶段网关发布并上传 rollout evidence |
| fix | prd-agent | 放宽 llmgw-prod-stage 紧急回滚入口，rollback-inproc 不再要求 commit、MAP logs key 或 gateway key |
