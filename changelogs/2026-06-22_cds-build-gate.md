| perf | cds | 新增全局构建并发闸（CDS_MAX_CONCURRENT_BUILDS，默认 3），多分支同时部署时排队，避免构建互相饿 CPU（实测并发时 admin 构建从 ~300s 膨胀到 845s） |
| feat | cds | 构建排队状态写进部署日志 + SSE + /api/cluster/status，用户看到「排队中，前面还有 N 个」而非疑似卡死的 spinner（每 15s 刷新位置） |
| fix | cds | 修复 cleanup-stopped 缺项目级鉴权（Bugbot High）：项目级 cdsp_ key 未带 ?project= 时锁定到自身项目，跨项目一律 assertProjectAccess 403，杜绝越权批量删分支 |
| fix | prd-api | 资产存储 auto 模式部分云凭据 fail-fast（Codex P2）：凭据配一半时报错而非静默回退本地，避免资产写容器本地盘重部署即丢；仅完全无云凭据才用 local 占位 |
| fix | prd-api | 本地存储传图 URL 可读（Codex P2）：image-master 文件读取补 assets/img + cds/img 两域，修复 local 模式下知识库/CDS 传图返回的 URL 404 |
| refactor | cds | 移除分支列表页孤儿轮询（Bugbot Low）：opsStatus/hostStats 写后不读且与 MonitoringDialog 的 useMonitoringData 重复轮询，删之省去 8s+30s 冗余请求 |
| fix | cds | 修复 cleanup-damaged-containers 缺项目级鉴权（Codex P1）：同 cleanup-stopped，项目级 cdsp_ key 锁定到自身项目，杜绝跨项目删容器 |
| fix | cds | 修复执行器卡片分支数恒显示 0（Bugbot Medium）：/api/executors 返回 branches 数组无 branchCount，卡片改用 branchCount ?? branches.length 兜底 |
