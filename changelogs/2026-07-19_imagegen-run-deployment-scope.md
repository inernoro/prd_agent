| fix | prd-api | 生图 run 队列按部署作用域隔离：ImageGenRun 增 DeploymentSlug（分支预览=CDS_BRANCH_SLUG，生产=null），worker 只认领本部署入队的 run，根治共享 Mongo 下旧构建部署抢单执行导致「分支修复反复复现」 |
