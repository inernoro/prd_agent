| feat | cds | self-status 改事件驱动：新增 SSE 端点 /api/self-status/stream（snapshot/update/keepalive 三类事件 + 25s 心跳）+ webhook push 事件触发 broadcastSelfStatus + 删除 60s server cache，回归"诚实"查询 |
| feat | cds | GlobalUpdateBadge 改用 EventSource 订阅 SSE，删除 30s/5s 双档自动轮询，新增"立即检查更新"手动刷新按钮（spin 动画 + 主题 token）；EventSource 不可用时回落 60s 兜底 polling |
