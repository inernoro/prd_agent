| feat | cds | 容器异常退出（崩溃/OOM）由 auto-restart 巡检留痕：写活动日志 + lastStopReason/Source=crash + stopCount，杜绝"分支莫名其妙停止零日志" |
| feat | cds | janitor 自动回收分支前写活动日志（actor=janitor），分支消失有迹可循 |
| feat | cds | 新增 POST /api/branches/:id/restart 轻量重启（docker restart，不重建代码），与重新部署区分 |
| feat | cds | 新增 GET /api/branches/:id/activity-logs 分支维度系统日志（最新在前） |
| feat | cds | 分支详情抽屉日志页签合一：Webhook/HTTP 并入「日志」，新增「系统日志」pill 展示谁停的/何时/为什么 |
| feat | cds | 分支详情底部按钮一分为二：重新启动（秒级拉起）+ 重新部署（拉新代码重建） |
| feat | cds | 分支卡加宽（2xl 才三列），footer 去掉 commit hash 改为部署时间 |
