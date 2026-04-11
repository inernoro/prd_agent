| feat | cds | Phase 2 cgroup 限制: BuildProfile.resources + compose-parser 支持 x-cds-resources / deploy.resources.limits 双源,container.runService 追加 --memory / --memory-swap / --cpus 标志 |
| feat | cds | Phase 2 JanitorService: 周期性扫描 lastAccessedAt > worktreeTTLDays 的分支并通过 callback 删除,跳过 pinned/defaultBranch/colorMarked,同时做磁盘水位告警(statfsSync) |
| feat | cds | Phase 2 Master 容器化: Dockerfile.master (multi-stage + docker CLI + healthcheck) + systemd/cds-master.service (Restart=always + security hardening) |
| feat | cds | Phase 2 GET /healthz 健康检查端点: state 可读 + docker 可达双检查,返回 200/503,public 无 auth 供 Docker/systemd/Nginx 主动探测 |
| feat | cds | Phase 3 BranchDispatcher: 读取每个 executor 的 /api/scheduler/state,按 capacityUsage.current/max 比率做 capacity-aware 派发(fallback 到 least-branches) |
| feat | cds | Phase 3 POST /api/executors/dispatch/:branch: 调度 API 支持 capacity-aware / least-branches 两种策略 |
| feat | cds | Phase 3 Nginx 模板生成器: generateUpstreamBlock + generateBranchMap + generateFullConfig,支持 draining → backup、offline → 排除、proxy_buffering off (SSE 支持) |
| docs | doc | design.cds-resilience.md v2.0: 扩展 Phase 2/3 章节 + 3 层分布式架构图 + 职责切分矩阵 + 集群部署 runbook + 单机 vs 集群决策树 |
| docs | doc | plan.cds-resilience-rollout.md: Phase 2/3 checkbox 全打勾,记录 60 个新单测覆盖,标注待运维部署项 |
| docs | doc | design.cds.md §8: 补 v3.1/v3.2/v3.3 三阶段状态表 + 核心理念三层 |
