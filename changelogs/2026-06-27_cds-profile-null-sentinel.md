| fix | cds | 根治 branch override 的 null 结构哨兵覆盖 baseline（sanitizeProfileOverride 在 merge/writer 双端剥 null），整类 `invalid containerPort: null` / 空镜像 `sh:latest` 部署故障一次性消失 |
| fix | cds | docker run 前增加空镜像断言：解析出的 dockerImage 为空或含未解析模板时明确报错并指出是 CDS profile 解析问题，不再误判为 Docker 镜像问题 |
| fix | cds | 看门狗双路径各自 try/catch：webhook 派发收敛与卡死收敛崩溃各记各的 action/source，不再张冠李戴（Bugbot Low #940） |
| fix | cds | 服务级卡死收敛改了 service.status 后重算分支聚合 status/errorMessage，避免发出「branch 仍 running、某 service 已 error」的脏更新（Codex P2 #940） |
| fix | cds | 卡死看门狗有在途操作的分支整条跳过，合法长任务（>45min 编译/迁移）不被硬超时误杀（Bugbot Medium #940） |
| fix | cds | 卡死看门狗：有服务的分支聚合状态一律以服务真实状态为准，治「服务全 stopped 但分支仍 running」（Bugbot Medium #940） |
| fix | cds | 源码部署 pull 后用 parsePulledSha 取裸 SHA（优先 after）刷新 githubCommitSha + 构建历史版本列，治 head 带标题不匹配裸 SHA 正则导致版本列停在旧 SHA（Codex P2 #940） |
