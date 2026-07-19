| fix | prd-api | 生图 run 队列按部署作用域隔离：ImageGenRun 增 DeploymentSlug（分支预览取 CDS_PROJECT_ID 标记 + 实际注入的 BULLMQ_PREFIX/VITE_GIT_BRANCH 分支 slug，生产=null），worker 只认领本部署入队的 run，根治共享 Mongo 下旧构建部署抢单执行导致「分支修复反复复现」 |
| fix | prd-api | 生图幂等键按部署作用域隔离（ScopeIdempotencyKey 加 scope 前缀，生产原样）+ WeeklyPoster run 复用查询同作用域过滤，防前端确定性键跨分支预览撞唯一索引/复用异部署 run（Codex P1/P2） |
| test | prd-api | MongoIdConventionTests 网关豁免放宽为 PrdAgent.LlmGw 前缀：修复 main 合入的 GatewayRecoveryOperation（LlmGw.Provisioning 命名空间）被误拦导致 CI 红（守卫本意豁免整个网关新库的纯 GUID 字符串主键） |
