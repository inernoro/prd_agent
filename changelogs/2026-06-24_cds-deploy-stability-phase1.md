| fix | cds | 部署重试默认关闭（治重试风暴）：CDS_DEPLOY_DISPATCH_RETRY_ENABLED 未设则对账器只标记 stale 不自动补发部署，根治多部署来源互相抢占打满 CPU 导致整个 CDS 进不去 |
| fix | cds | 根治 fenced-cleanup 竞态(No such container)：被抢占的部署清容器前，若有更新的 runtime-producing 操作(deploy/restart/auto-restart 等)在接管则跳过删除，避免删掉对方正用的容器导致 restart/auto-wake 报 No such container、服务 0/N |
| feat | cds | 发布探活分阶段：部署首启就绪探测加系统级下限 deployReadinessFloorSeconds(默认1200s,项目可覆盖),取 max(profile超时,下限),避免慢首启(构建/JVM暖机)被探活超时误杀;运行期重启/唤醒不受影响保持短超时 |
