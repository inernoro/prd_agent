| feat | cds | CDS 系统设置新增「GitHub Webhook 日志」tab — 列表展示每次 hook 投递,点击展开看 deliveryId / 耗时 / 验签状态 / dispatch 决策 / payload(截断 4KB);ring buffer 200 条上限 |
| feat | cds | 后端 GET /api/cds-system/github/webhook-deliveries + state.recordGithubWebhookDelivery + github-webhook 路由 res.on('finish') 监听写日志(成功失败均记录) |
| feat | cds | BranchListPage kebab 菜单新增「重新生成」按钮 — 调已有 force-rebuild 端点遍历分支所有 profile 重建,适用 vite 卡住等异常状态 |
