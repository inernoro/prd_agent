| fix | cds | infra 容器全链路修复 yaml `command:` 透传:`ComposeServiceDef` / `InfraService` 加 command + entrypoint + restartPolicy 字段;parser 提取;`composeDefToInfraService` / `pending-import apply` 写库;`docker run` 把 cmd 拼到 image 之后 + `--entrypoint` flag。修 openvisual minio 容器无 cmd 启动后 exit 0 + unless-stopped 288 次重启拖垮 host 的灾难 |
| fix | cds | infra 容器默认 `--restart` 从硬编码 `unless-stopped` 改成 `on-failure:3`,可在 yaml 用 `restart:` 字段覆盖。避免烂配置 churn 全 host |
| feat | cds | 新增 `infra-flap-watchdog`:每 60s 扫所有 `cds.type=infra` 容器的 RestartCount,5 分钟内 delta ≥5 → 自动 `docker stop` 打破循环 + 标 service.status=error + bus 广播 `infra.flap.circuit-breaker` 事件。env: `CDS_INFRA_FLAP_*` 可调 |
| feat | cds | pending-import 审批时新增 infra cmd 白名单校验:minio/elasticsearch 这类需要子命令的 image 缺 cmd 直接 400 拒绝并给出修复示例,源头堵住灾难复现 |
| feat | cds | 所有 CDS 管理容器新增 `cds.project.id` label(app + infra),为后续按项目过滤清理铺路。老 legacy infra 用 `_legacy` 占位 |
| feat | cds | cds-events-bus 新增事件类型:`pending-import.created` / `pending-import.decided` / `pending-import.count` / `infra.flap.circuit-breaker`。pending-import 提交/审批/拒绝时实时 publish,替代前端 10s 轮询(全局徽章前端待 Phase B 接入) |
