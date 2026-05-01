| feat | cds | deploy 路由(`/api/branches/:id/deploy`)兜底自动启动项目下所有未运行的 infra,无论 BuildProfile 是否声明 dependsOn。判断标准是 docker 容器实际状态(通过 `discoverInfraContainers` 取),不信赖 stale state — 解决"state 写 running 但容器实际 Exited"导致 deploy 跳过 infra 的 bug |
| fix | cds | `discoverInfraContainers` Map key 从 `cds.service.id` 改为 `containerName`(跨项目唯一)。原实现下,project A 和 B 都有 svc.id='mongodb' 时,Map.set 互相覆盖,reconcile / deploy 检查会拿到错的容器。containerName(`cds-infra-{slug}-{id}`)全局唯一 |
| fix | cds | `index.ts` reconcile 路径同步用 `svc.containerName` 查 discovered map(配合上面的 key 改动) |
| fix | cds | deploy 流"启动依赖 infra"循环不再用 `infra.status === 'running'` 跳过 — requiredInfraIds 已经过 docker 实际状态过滤,这里再 check stale state 会漏 |
| docs | cds | `doc/plan.cds-mysql-readiness.md` Phase 2 章节勾选完成 + 进度日志追加 |
