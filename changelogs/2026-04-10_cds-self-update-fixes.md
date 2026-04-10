| fix | cds | exec_cds.sh 新增 --background 参数别名（等同于 daemon），修复 self-update 静默失败导致 CDS 整体宕机 |
| fix | cds | self-update spawn 改为规范 daemon 参数 + 子进程 stdout/stderr 重定向到 .cds/self-update-error.log，失败不再无声 |
| feat | cds | deploy 端点启动时检测 maxContainers 容量超售，超售发送 SSE capacity-warn 事件 + 写入 deploy log |
| docs | doc | plan.cds-resilience-rollout.md 补 Phase 1.5 pipeline 验证记录 + 3 个 pre-existing bug 根因 + Phase 2 优先级调整 |
