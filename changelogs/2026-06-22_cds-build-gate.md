| perf | cds | 新增全局构建并发闸（CDS_MAX_CONCURRENT_BUILDS，默认 3），多分支同时部署时排队，避免构建互相饿 CPU（实测并发时 admin 构建从 ~300s 膨胀到 845s） |
| feat | cds | 构建排队状态写进部署日志 + SSE + /api/cluster/status，用户看到「排队中，前面还有 N 个」而非疑似卡死的 spinner（每 15s 刷新位置） |
| perf | prd-admin | CDS vite build 放宽并行度（maxParallelFileOps 1→4、UV_THREADPOOL_SIZE 2→4，均可env覆盖）——并发闸兜住同时构建数后不再需要极限串行防 OOM，显著加速大型前端构建 |
