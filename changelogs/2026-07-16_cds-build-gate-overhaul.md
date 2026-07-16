| fix | cds | build-gate 支持排队取消（signal/isCancelled）与持有者身份，被 supersede 的部署 15 秒内出队，不再僵尸占位撑大全局等待数 |
| fix | cds | 极速版（prebuilt）部署不再占用全局构建槽；镜像拉取失败回退源码编译时经 onSourceCompileFallback 钩子回补槽位 |
| fix | cds | waitForReadiness 支持容器活性早退：连续两次 inspect 到 exited/dead/消失即刻失败放槽，崩溃容器不再空占构建槽等满 1200s 就绪下限 |
| fix | cds | reconcileInterrupted 周期化（每 5 分钟），心跳停跳的幽灵 building run 最迟 20 分钟收敛为失败，不再依赖重启 |
| fix | cds | 部署层内 fan-out 改用 deploy-layer-runner（allSettled + 共享 abort）：兄弟服务闭包不再脱管续跑，根治同分支重复租约叠加 |
| feat | cds | manual 整分支 deploy 撞车不再 409，合并为最新待部署请求（与 webhook 同通道，last-writer-wins），派发时透传原始 trigger，掐断 agent 重试风暴 |
| fix | cds | 单服务重部署路由（POST /branches/:id/deploy/:profileId）补齐 build-gate 过闸，源码编译不再绕过全局并发控制 |
| feat | cds | 全局构建并发上限运行时可调：GET/PUT /api/cluster/build-gate（CdsState.maxConcurrentBuilds 持久化，env 仍为最终 override），上调即 pumpWaiters 唤醒排队者；/api/cluster/status 的 buildGate 透出 holders/waiters 身份明细 |
| test | cds | build-gate 取消/身份/pump、deploy-layer-runner、coordinator manual 合并、reconcileInterrupted 周期语义、waitForReadiness 活性早退共 5 个套件新增或扩展 |
