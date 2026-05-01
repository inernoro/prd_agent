| fix | cds | Phase 6 实战 — Twenty CRM 真实部署暴露 + 修 2 个真 bug:`bash -c` 改 `sh -c`(B9,所有 alpine 镜像受益)+ singlePassResolve 容忍非 string env value(B9.1,yaml 数字字符串解析问题)|
| feat | cds-skill | cdscli `_yaml_from_compose_services` + dev mode command 都改用 sh -c(POSIX 通用,不依赖 bash) |
| docs | cds | plan.cds-mysql-readiness.md § 八 Phase 7 backlog 扩到 14 条,新增 B9-B14(Twenty 实战暴露的 docker entrypoint / readiness probe / dependsOn healthy / env API 设计等真盲区)|
| docs | cds | plan § 九 Phase 6 进度表加一行 — Twenty 完整实战暴露 6 个新 bug,确认机制层面 Phase 1-5 全 work,卡点是 CDS 后端能力(BuildProfile entrypoint / no-http-readiness / wait-for-healthy 都待加)|
