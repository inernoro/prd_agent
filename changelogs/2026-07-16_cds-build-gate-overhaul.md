| fix | cds | build-gate 支持排队取消（signal/isCancelled）与持有者身份，被 supersede 的部署 15 秒内出队，不再僵尸占位撑大全局等待数 |
| fix | cds | 极速版（prebuilt）部署不再占用全局构建槽；镜像拉取失败回退源码编译时经 onSourceCompileFallback 钩子回补槽位 |
| fix | cds | waitForReadiness 支持容器活性早退：连续两次 inspect 到 exited/dead/消失即刻失败放槽，崩溃容器不再空占构建槽等满 1200s 就绪下限 |
| fix | cds | reconcileInterrupted 周期化（每 5 分钟），心跳停跳的幽灵 building run 最迟 20 分钟收敛为失败，不再依赖重启 |
| fix | cds | 部署层内 fan-out 改用 deploy-layer-runner（allSettled + 共享 abort）：兄弟服务闭包不再脱管续跑，根治同分支重复租约叠加 |
| feat | cds | manual 整分支 deploy 撞车不再 409，合并为最新待部署请求（与 webhook 同通道，last-writer-wins），派发时透传原始 trigger，掐断 agent 重试风暴 |
| fix | cds | 单服务重部署路由（POST /branches/:id/deploy/:profileId）补齐 build-gate 过闸，源码编译不再绕过全局并发控制 |
| feat | cds | 全局构建并发上限运行时可调：GET/PUT /api/cluster/build-gate（CdsState.maxConcurrentBuilds 持久化，env 仍为最终 override），上调即 pumpWaiters 唤醒排队者；/api/cluster/status 的 buildGate 透出 holders/waiters 身份明细 |
| test | cds | build-gate 取消/身份/pump、deploy-layer-runner、coordinator manual 合并、reconcileInterrupted 周期语义、waitForReadiness 活性早退共 5 个套件新增或扩展 |
| feat | cds | 构建队列健康判定常态化：evaluateBuildGateHealth 纯函数（积压/持槽超时/幽灵 run/账目不变量四类退化）+ GET /api/cluster/build-gate/health（健康 200 / 退化 503，供任务调度定时回归探测）+ 进程内 build-gate-watchdog 每 60s 采样、退化写系统事件告警、恢复留痕 |
| test | cds | build-gate-health 回归门禁套件（8 例：四类退化 + 阈值边界 + 多退化并存 + 坏时间戳容错），随 CI cds-build job 门禁 PR |
| fix | cds | 回应 Codex P1：构建并发上限下调后 release 不再无条件转移槽位，active 高于新上限时先缩减，紧急节流即时生效 |
| fix | cds | 回应 Codex P2：manual 部署被合并（merged）时 BranchListPage/BranchDetailPage 如实显示「已合并为待部署请求」，不再误报「部署完成」 |
| fix | cds | 分支预览「热重启」等待页卡 86% 修复：热重启改用独立 restart 历史耗时样本桶（auto-wake/手动 restart 成功时记录），进度条按 elapsed/median 真实推进，无样本时按重启时长曲线持续移动；唤醒的启动信号等待收紧到 120s + 就绪探测启用容器活性早退，等待上限从最坏 40 分钟降到分钟级 |
| fix | cds | 回应 Codex P2：上限下调后的自然收敛（active>max 且账目一致）不再被健康探针误报 503，账目不变量改为 active 与持有者明细数一致性 |
| fix | cds | 回应 Codex P2：部署静默阶段（构建输出/启动信号/就绪探测最长 1200s）打 30s 节流 run 心跳，周期收割器不再误杀活着的慢启动部署 |
| fix | cds | 回应 Codex P2 x3：manual 合并仅限部署类在途操作（stop/reset/delete 在途维持 409，防停止后被自动重启）；带 versionId 的版本重部署不合并（防重放丢版本配置）；极速版 pre-run docker rm 后移到拉取/回退闸之后（排队期旧预览不再白宕机） |
| fix | cds | 回应 Codex P2：merged 部署请求不再打开旧版本预览（BranchListPage 合并分支改为关闭预览占位窗口，消除「已部署完成」假象） |
| rule | cds | 新增 .claude/rules/concurrency-gate-discipline.md：并发闸/队列组件五件套设计纪律（等待可取消/持有者身份/只锁真实资源/周期收敛/健康不变量+常态回归），固化本次队列堵死事故教训 |
| docs | cds | 新增 doc/debt.cds.build-gate.md 债务台账（pending 队列更名/排队心跳拆分/holders 运维 UI/健康阈值可配等延期项），同步 index.yml 与 guide.list.directory.md |
| fix | cds | 回应 Codex P2：带一次性选项（?force=1 / ?ignoreRequired=1 / targetExecutorId）的 manual deploy 不参与合并去重（pending 重放丢选项会导致强制部署被暂停闸门拦下、env 豁免失效、执行器指定丢失），撞车维持 409 |
| fix | cds | 回应 Codex P2：构建闸健康探针 GET /api/cluster/build-gate/health 补登 github-auth 模式 PUBLIC_PATHS 白名单（此前仅在 basic-auth 白名单，CDS_AUTH_MODE=github 部署下探针 401 不可用） |
| fix | cds | 回应 Codex P2：manual 整分支 deploy 撞上保留的 force-rebuild 续约时合并为 pending 而非拒绝——已合并 pending 的内部重放撞续约不再被 409 静默丢弃，续约操作完成后照常派发；force-rebuild 自己的续约仍优先接续不被合并 |
