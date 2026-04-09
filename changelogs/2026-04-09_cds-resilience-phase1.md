| feat | cds | 新增分支温池调度器 (SchedulerService)：LRU 驱逐 + idleTTL 自动休眠 + 四源 pinning，用 maxHotBranches 为小服务器提供容量预算与故障隔离 |
| feat | cds | GET/POST /api/scheduler/{state,pin,unpin,cool}:slug 四个端点，Dashboard 可观测并手动干预温池 |
| feat | cds | 代理命中分支后自动 scheduler.touch 更新 LRU（15s 节流持久化） |
| fix | cds | StateService.save 改为原子写 + 滚动备份（state.json.bak.<ts> 保留 10 份），载入时从最新备份恢复损坏 state |
| docs | doc | 新增 design.cds-resilience.md（小服务器负载均衡设计）、plan.cds-resilience-rollout.md（可续传进度追踪），design.cds.md 补核心思想 + 文档地图 + HA 章节 |
