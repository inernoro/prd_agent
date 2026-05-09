| feat | cds | Phase B' 控制面/数据面分离 + 蓝绿部署 — 7 阶段累计 +202 测试 / 1484 全绿 / 6747 行新代码 |
| feat | cds | admin daemon --standby 模式 + /api/_internal/promote 激活 + 严格回环 IP 校验(B'.2,a007f467) |
| feat | cds | nginx-upstream-writer 原子写 + nginx -t + reload + 回滚(B'.4,4fc24d5e) |
| feat | cds | graceful-shutdown SIGTERM drain SSE/worker/mongo flush + 30s 兜底 — 已接入 SIGTERM,单进程旧路径也立即受益(B'.3,8293107f) |
| feat | cds | forwarder 4 模块 — route-resolver / mongo-watcher+JSON fallback / HTTP+SSE+WebSocket 反代 / 诊断接口(B'.2-fwd,2aff8680) |
| feat | cds | blue-green-supervisor 编排器 — spawn → healthz → nginx → promote → shutdown + 自动熔断 + 锁文件防并发(B'.3+,8c80dabb) |
| feat | cds | network-topology API + Dashboard build-sha chip + 漂移检测(B'.6,57a596a0) |
| feat | cds | self-update / force-sync 接入 supervisor + UI mode='blue-green' chip(B'.5,0299eddc),CDS_ENABLE_BLUE_GREEN=1 启用,默认零退化 |
| docs | cds | doc/guide.cds-blue-green-rollout.md 上线运维手册 + Step 1-6 + 1 行回退 + 8 条 UAT 验收 |
