| fix | prd-api | 生图失败/取消时回填画布占位为 error（原先只在成功路径回填，失败的 run 让画布永远停在 running 转圈） |
| feat | prd-api | 新增画布对账接口 POST /api/visual-agent/image-master/workspaces/{id}/canvas/reconcile：按 run.TargetCanvasKey 反查真实结果修复卡死占位，不依赖前端 runId，可拯救历史孤儿 |
| fix | prd-admin | 视觉创作 SSE 流结束不再盲目标 error：先查后端真实状态，成功则回填、仍在跑则保留占位，避免慢任务被代理 EOF 误判 |
| fix | prd-admin | 拿到 runId 后立即持久化画布（不等 debounce），避免关页/切走导致占位丢失 runId 成为孤儿 |
| fix | prd-admin | 看门狗改走 workspace 级对账（覆盖无 runId 占位）+ 阈值 120s 降到 45s；加载即对账修复历史卡死占位 |
| fix | prd-admin | 视觉创作三处生图 SSE 订阅补齐 maxAttempts=20（原默认 10，慢任务过早放弃） |
