| fix | cds | clone 端点对旧项目缺失 repoPath 自动 backfill（#551 a），不再返回 no_repo_path 让用户重建项目 |
| fix | cds | 启动时把 stale building/starting/restarting 分支收敛为 error 并写明 errorMessage（#551 c）|
| fix | cds | branch logs 端点在无 OperationLog 但状态为 error 时返回合成 fallback 记录暴露 errorMessage（#551 d）|
| feat | cds | 401 响应新增 hint + acceptedHeaders，并兼容 ai-access-key / Authorization Bearer 别名（#552 CDS-CLI-005）|
| feat | cds | GET /api/projects/:id 对半成品/未 clone 项目返回 recovery.nextActions 提示 Agent 下一步（#552 CDS-CLI-007）|
